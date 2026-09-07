'use strict';
// Existing ST UI + real Anima HTTP server + fake LLM/GPU/storage only.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');
const { ID, RUNTIME_FILES } = require('./install-ui.cjs');

async function main() {
    const url = new URL(process.argv[2] || 'http://127.0.0.1:8001');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Loopback ST URL required');
    const mcpRoot = process.env.ANIMA_MCP_PROJECT || '/home/ubuntu/Mcp-image/anima-comfyui-mcp';
    const token = 'mcp-ui-fixture-token-0000000000000000000';
    const child = spawn(path.join(mcpRoot, 'venv/bin/python'), [path.join(mcpRoot, 'tests/http_fixture.py'), '--origin', url.origin], { cwd: mcpRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '', browser;
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const childDone = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
    try {
        const mcpUrl = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('MCP fixture startup timeout: ' + errors)), 15000);
            child.once('error', error => { clearTimeout(timer); reject(error); });
            child.once('exit', code => { clearTimeout(timer); reject(new Error(`MCP fixture exited: ${code} ${errors}`)); });
            child.stdout.on('data', () => { const match = /FIXTURE_URL (\S+)/.exec(output); if (match) { clearTimeout(timer); resolve(match[1]); } });
        });
        // Wait for the fixture's real socket, not a fixed startup sleep.
        for (let attempt = 0; ; attempt++) {
            try { const response = await fetch(mcpUrl); if (response.status === 401) break; } catch {}
            if (attempt === 50) throw new Error('MCP fixture did not become ready');
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const mcpOrigin = new URL(mcpUrl).origin;
        const { PNG_BASE64, PNG_BYTES } = await import('../extension/tests/fixtures.mjs');
        const prefix = `/scripts/extensions/third-party/${ID}/`, key = 'sillytavern_custom_text2img';
        const files = new Set(RUNTIME_FILES);
        const calls = [], uploads = [], blocked = [], pageErrors = [], writes = [];
        const plan = JSON.stringify({ scenes: [{ after_id: 'p1', label: 'Forest', prompt: 'safe, landscape, forest' }] });
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
        const page = await context.newPage(); page.setDefaultTimeout(20000);
        page.on('pageerror', error => pageErrors.push(error.message));
        // Do not intercept MCP at all: Chromium must enforce genuine CORS.
        await context.route(target => target.origin !== mcpOrigin, async route => {
            const request = route.request(), target = new URL(request.url());
            if (target.origin === 'https://llm-fixture.invalid') {
                if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': url.origin, 'Access-Control-Allow-Methods': 'POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type' } });
                const body = request.postDataJSON(); calls.push(body);
                assert.equal(request.headers().authorization, 'Bearer fake-llm-key');
                assert.ok(!JSON.stringify(body).includes(token));
                const hasToolResult = body.messages.some(message => message.role === 'tool');
                const message = hasToolResult ? { content: plan } : { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'anima_validate_prompt', arguments: '{"prompt":"safe, landscape, forest"}' } }] };
                return route.fulfill({ status: 200, headers: { 'Access-Control-Allow-Origin': url.origin }, json: { choices: [{ finish_reason: hasToolResult ? 'stop' : 'tool_calls', message }] } });
            }
            if (target.origin !== url.origin) { blocked.push(request.url()); return route.abort(); }
            if (target.pathname.startsWith(prefix)) {
                const file = target.pathname.slice(prefix.length);
                if (!files.has(file)) return route.fulfill({ status: 404, body: 'Missing fixture asset' });
                return route.fulfill({ status: 200, path: path.join(__dirname, '../extension', file) });
            }
            if (target.pathname === '/api/settings/get') {
                const response = await route.fetch(), body = await response.json(), settings = JSON.parse(body.settings);
                settings.extension_settings[key] = { enabled: true, provider: 'anima-mcp', mcpUrl, mcpReadSkill: true, mcpPromptEnabled: true,
                    mcpPromptTools: ['anima_validate_prompt'], mcpSeed: '18446744073709551613', mcpBatchSize: '2',
                    promptConnectionMode: 'manual', manualLlmBaseUrl: 'https://llm-fixture.invalid/v1', manualLlmModel: 'fixture', manualLlmApiKey: 'fake-llm-key', reviewPrompt: false };
                body.settings = JSON.stringify(settings); return route.fulfill({ response, json: body });
            }
            if (target.pathname === '/api/settings/save') {
                writes.push(request.postDataJSON()); assert.ok(!request.postData().includes(token));
                return route.fulfill({ status: 200, json: { result: 'ok' } });
            }
            if (target.pathname === '/api/images/upload') {
                const body = request.postDataJSON(); assert.equal(body.image, PNG_BASE64); uploads.push(body);
                return route.fulfill({ status: 200, json: { path: `/user/images/__mcp_fixture__/${uploads.length}.png` } });
            }
            if (target.pathname.startsWith('/user/images/__mcp_fixture__/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES });
            if (target.pathname.startsWith('/api/plugins/')) { blocked.push(target.pathname); return route.abort(); }
            if (target.pathname === '/api/quick-replies/save') return route.fulfill({ status: 200, body: 'OK' });
            if (target.pathname === '/api/horde/status') return route.fulfill({ status: 200, json: { ok: false } });
            if (target.pathname === '/api/horde/text-models' || target.pathname === '/api/sd/comfy/workflows') return route.fulfill({ status: 200, json: [] });
            if (target.pathname === '/api/image-metadata/all') return route.fulfill({ status: 200, json: { version: 1, images: {} } });
            const reads = new Set(['/api/characters/all', '/api/characters/get', '/api/characters/chats', '/api/backgrounds/all', '/api/backgrounds/folders', '/api/avatars/get', '/api/groups/all', '/api/chats/get', '/api/chats/group/get', '/api/chats/recent', '/api/worldinfo/get', '/api/worldinfo/list', '/api/secrets/read', '/api/stats/get']);
            if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method()) && !reads.has(target.pathname)) { blocked.push(target.pathname); return route.abort(); }
            return route.continue();
        });
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        await page.locator('#cmi_settings').waitFor({ state: 'attached' });
        await page.waitForFunction(() => SillyTavern.getContext().eventSource.autoFireLastArgs.has('app_ready'));
        await page.evaluate(() => {
            const original = SillyTavern.getContext.bind(SillyTavern), context = original();
            window.__mcpSavedChats = 0;
            SillyTavern.getContext = () => ({ ...original(), name2: 'MCP fixture', characterId: 0, groupId: null,
                getCurrentChatId: () => 'mcp-fixture', getCharacterCardFields: () => ({ description: 'A peaceful forest landscape.' }),
                saveChat: async () => { window.__mcpSavedChats++; } });
            const message = { name: 'MCP fixture', is_user: false, is_system: false, send_date: new Date().toISOString(), mes: 'Sunrise lights a peaceful forest.', swipe_id: 0, extra: {} };
            context.chat.splice(0, context.chat.length, message); document.getElementById('chat').replaceChildren();
            context.addOneMessage(message, { scroll: false, showSwipes: false });
            context.eventSource.emit(context.event_types.CHARACTER_MESSAGE_RENDERED, 0);
        });
        await page.locator('#extensions-settings-button > .drawer-toggle').click();
        if (!(await page.locator('#cmi_provider').isVisible())) await page.locator('#cmi_settings > .inline-drawer > .inline-drawer-toggle').click();
        await page.locator('#cmi_mcp_section > summary').click();
        await page.locator('#cmi_mcp_token').fill(token); await page.locator('#cmi_mcp_apply').click();
        assert.equal(await page.locator('#cmi_mcp_token').inputValue(), '');
        await page.locator('#cmi_mcp_test').click();
        await page.waitForFunction(() => document.getElementById('cmi_mcp_status').textContent.includes('連線成功'));
        assert.ok(!output.includes('FIXTURE_GENERATE'));
        await page.locator('#cmi_mcp_dry_run').click();
        await page.waitForFunction(() => document.getElementById('cmi_mcp_status').textContent.includes('Dry-run 成功'));
        assert.equal((output.match(/FIXTURE_GENERATE dry-run/g) || []).length, 1);
        assert.equal((output.match(/FIXTURE_GENERATE image/g) || []).length, 0);
        fs.mkdirSync(path.join(__dirname, '../test-results'), { recursive: true });
        await page.screenshot({ path: path.join(__dirname, '../test-results/mcp-settings-desktop.png') });
        await page.locator('#extensions-settings-button > .drawer-toggle').click();
        await page.evaluate(() => toastr.remove());
        const floor = page.locator('#chat .mes[mesid="0"]');
        if (!(await floor.locator('.cmi_message_analyze').isVisible())) await floor.locator('.extraMesButtonsHint').click();
        await floor.locator('.cmi_message_analyze').click();
        await page.waitForFunction(() => window.__mcpSavedChats === 1 && document.querySelector('#chat .cmi-inline-generate:not(:disabled)'));
        assert.equal(calls.length, 2); assert.ok(calls[1].messages.some(message => message.role === 'tool'));
        assert.equal(uploads.length, 0); assert.equal((output.match(/FIXTURE_GENERATE image/g) || []).length, 0);
        assert.ok(calls[0].messages.some(message => message.content?.includes('Anima reference data')));
        await page.evaluate(() => toastr.remove());
        await floor.locator('.cmi-inline-generate').click();
        await page.waitForFunction(() => window.__mcpSavedChats === 2);
        assert.equal(uploads.length, 2); assert.equal((output.match(/FIXTURE_GENERATE image/g) || []).length, 1);
        const state = await page.evaluate(() => SillyTavern.getContext().chat[0]);
        assert.equal(state.extra.cmi_inline_scenes.slots[0].media[0].seed, '18446744073709551613');
        assert.equal(state.extra.media?.length || 0, 0);
        await page.waitForFunction(() => [...document.querySelectorAll('#chat .cmi-inline-scene img')].every(image => image.complete && image.naturalWidth > 0));
        await page.evaluate(() => toastr.remove());
        await page.screenshot({ path: path.join(__dirname, '../test-results/mcp-inline-desktop.png') });
        await page.evaluate(() => { const context = SillyTavern.getContext(); context.updateMessageBlock(0, context.chat[0]); });
        assert.equal(calls.length, 2); assert.equal((output.match(/FIXTURE_GENERATE image/g) || []).length, 1);
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#extensions-settings-button > .drawer-toggle').click();
        await page.locator('#cmi_mcp_section').scrollIntoViewIfNeeded();
        await page.screenshot({ path: path.join(__dirname, '../test-results/mcp-settings-mobile.png') });
        assert.ok(await page.evaluate(() => document.getElementById('cmi_settings').scrollWidth <= document.getElementById('cmi_settings').clientWidth + 2), 'MCP settings should not overflow on mobile');
        const logs = await page.locator('#cmi_log_output').textContent(); assert.ok(!logs.includes(token));
        await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#cmi_settings').waitFor({ state: 'attached' });
        if (!(await page.locator('#rm_extensions_block').isVisible())) await page.locator('#extensions-settings-button > .drawer-toggle').click();
        if (!(await page.locator('#cmi_provider').isVisible())) await page.locator('#cmi_settings > .inline-drawer > .inline-drawer-toggle').click();
        if (!(await page.locator('#cmi_mcp_test').isVisible())) await page.locator('#cmi_mcp_section > summary').click();
        await page.locator('#cmi_mcp_test').click(); await page.waitForFunction(() => document.getElementById('cmi_mcp_status').textContent.includes('套用 Token'));
        assert.equal((output.match(/FIXTURE_GENERATE image/g) || []).length, 1);
        assert.deepEqual(pageErrors, []); assert.deepEqual(blocked, []);
        console.log(JSON.stringify({ ok: true, realMcpHttp: true, nativeCors: true, llmCalls: calls.length, fakeImageCalls: 1, uploads: uploads.length, blockedSettingsWrites: writes.length, screenshots: 'test-results/mcp-*.png' }, null, 2));
    } finally {
        await browser?.close();
        if (child.exitCode === null) child.kill('SIGTERM');
        await childDone;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
