import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { generateWithPolling } from '../generation.js';
import { PROVIDER_DEFAULTS, SETTINGS_KEY, migrateSettings, providerConnection, buildNovelPayload } from '../providers.js';

// Execute the actual message-button functions, replacing only browser/ST imports
// and the startup DOM hook. No network, real credentials, chat files or paid APIs.
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replace(/\ninit\(\)\.catch\([^\n]+\);\s*$/, '');
assert.ok(!source.includes('init().catch'));
const JOB = 'a'.repeat(32);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';

function fixture({ provider = 'novelai', configured = true, onSubmit = () => {}, replyError = false, review = false } = {}) {
    const calls = [], saves = [], notifications = [], prompts = [], reviews = [];
    const settings = { ...PROVIDER_DEFAULTS, provider, enabled: true, profileId: 'independent', reviewPrompt: review,
        baseUrl: 'https://panel.trycloudflare.com', password: 'fake-panel-secret', panelPreset: 'read-only', seed: '18446744073709551613' };
    let savedChats = 0, rendered = 0;
    const message = { mes: 'A bright forest clearing at dawn.', name: 'Example', swipe_id: 0 };
    const context = {
        chat: [message], name2: 'Example', characterId: 0,
        extensionSettings: { [SETTINGS_KEY]: settings, connectionManager: { profiles: [{ id: 'independent' }] } },
        saveSettingsDebounced() {}, getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getCharacterCardFields: () => ({ description: 'A traveler in the forest.' }), substituteParamsExtended: text => text,
        getCurrentChatId: () => 'test-chat', humanizedDateTime: () => 'test-date',
        saveChat: async () => { savedChats++; }, appendMediaToMessage: () => { rendered++; },
        POPUP_TYPE: { INPUT: 'input' }, callGenericPopup: async (html, _type, prompt) => { reviews.push(html); return `${prompt}, edited`; },
        ConnectionManagerRequestService: {
            isProfileSupported: () => true,
            sendRequest: async (...args) => { prompts.push(args); return 'landscape, sunrise'; },
        },
    };
    const element = {};
    const button = { get: () => element, addClass() { return this; }, removeClass() { return this; }, closest: () => ({ attr: () => '0' }) };
    const toast = { find: () => ({ text() {} }) };
    const sandbox = {
        console, structuredClone, AbortController, AbortSignal,
        SillyTavern: { getContext: () => context },
        $: () => ({ length: 1 }),
        toastr: Object.fromEntries(['info', 'warning', 'error', 'success', 'clear'].map(kind => [kind, (...args) => { notifications.push({ kind, args }); return toast; }])),
        MEDIA_DISPLAY: { GALLERY: 'gallery' }, MEDIA_SOURCE: { GENERATED: 'generated' }, MEDIA_TYPE: { IMAGE: 'image' }, SCROLL_BEHAVIOR: { KEEP: 'keep' },
        PROVIDER_DEFAULTS, migrateSettings, providerConnection, buildNovelPayload, generateWithPolling,
        saveBase64AsFile: async (...args) => { saves.push(args); return `/images/test-${saves.length}.png`; },
        fetch: async (url, init) => {
            const body = init?.body ? JSON.parse(init.body) : {};
            calls.push({ url, body });
            if (url.endsWith('/probe')) return Response.json({ ok: true, id: 'sillytavern-custom-text2img', providers: ['comfy-modal', 'novelai'] });
            if (url.endsWith('/novelai/status')) return Response.json({ configured });
            if (url.endsWith('/preset')) return Response.json({ prompts: { positive: 'masterpiece', negative: 'blurry' }, loras: [{ name: 'test-lora' }] });
            if (url.endsWith('/jobs')) {
                onSubmit(context);
                if (replyError) return Response.json({ error: '<b>upstream failed</b>' }, { status: 502 });
                return Response.json({ job_id: JOB, next_cursor: 1, finished: true,
                    events: [{ type: 'done', seed: '0', images: [`${JOB}/0.png`, `${JOB}/1.png`] }] }, { status: 202 });
            }
            if (url.endsWith('/output')) return Response.json({ data: PNG, format: 'png', seed: body.path.endsWith('/0.png') ? '0' : '1' });
            assert.fail(`Unexpected UI request: ${url}`);
        },
    };
    vm.runInNewContext(`${source}\nglobalThis.api = { onMessageButtonClick };`, sandbox, { filename: 'extension/index.js' });
    return { run: () => sandbox.api.onMessageButtonClick(button), context, message, settings, calls, saves, notifications, prompts, reviews,
        get savedChats() { return savedChats; }, get rendered() { return rendered; } };
}

test('real NovelAI button flow: independent prompt profile, multiple native gallery images, no panel credentials', async () => {
    const f = fixture({ review: true });
    await f.run();
    assert.equal(f.prompts.length, 1);
    assert.equal(f.prompts[0][0], 'independent');
    assert.equal(f.prompts[0][3].includePreset, true);
    assert.equal(f.saves.length, 2);
    assert.equal(f.savedChats, 1);
    assert.equal(f.rendered, 1);
    assert.equal(f.message.extra.media.length, 2);
    assert.equal(f.message.extra.media[0].seed, '0');
    assert.equal(f.message.extra.media[1].seed, '1');
    assert.equal(f.message.extra.media[0].source, 'generated');
    assert.match(f.reviews[0], /NovelAI/);
    assert.match(f.message.extra.media[0].title, /edited/);
    assert.ok(!JSON.stringify(f.calls).includes('fake-panel-secret'));
    assert.ok(f.calls.every(call => call.url.endsWith('/probe') || call.url.includes('/novelai/')));
    assert.equal(f.notifications.some(item => item.kind === 'error'), false);
});

test('real ComfyUI button flow preserves presets, LoRAs, string seed and original connection after switching settings', async () => {
    const f = fixture({ provider: 'comfy-modal', onSubmit(context) {
        const settings = context.extensionSettings[SETTINGS_KEY];
        settings.provider = 'novelai'; settings.password = 'changed'; settings.baseUrl = 'https://other.invalid';
    } });
    await f.run();
    assert.equal(f.savedChats, 1);
    const submitted = f.calls.find(call => call.url.endsWith('/jobs'));
    assert.equal(submitted.body.payload.seed, '18446744073709551613');
    assert.equal(submitted.body.payload.loras[0].name, 'test-lora');
    assert.match(submitted.body.payload.prompt_text, /^masterpiece,/);
    assert.equal(f.message.extra.media[0].negative, 'blurry');
    for (const call of f.calls.filter(call => call.url.endsWith('/output'))) {
        assert.equal(call.body.password, 'fake-panel-secret');
        assert.equal(call.body.baseUrl, 'https://panel.trycloudflare.com');
        assert.ok(!call.url.includes('/novelai/'));
    }
});

test('missing NovelAI token fails before any LLM request, generation or image save', async () => {
    const f = fixture({ configured: false });
    await f.run();
    assert.equal(f.prompts.length, 0);
    assert.equal(f.saves.length, 0);
    assert.equal(f.savedChats, 0);
    assert.ok(f.notifications.some(item => item.kind === 'error' && item.args[0].includes('Token')));
});

test('a changed message is never replaced or attached to after generation', async () => {
    const f = fixture({ onSubmit(context) { context.chat[0] = { mes: 'a different message' }; } });
    await f.run();
    assert.equal(f.saves.length, 2);
    assert.equal(f.savedChats, 0);
    assert.equal(f.context.chat[0].extra, undefined);
    assert.ok(f.notifications.some(item => item.kind === 'warning'));
});

test('a lost submit response is not retried and errors are rendered as text', async () => {
    const f = fixture({ replyError: true });
    await f.run();
    assert.equal(f.calls.filter(call => call.url.endsWith('/jobs')).length, 1);
    assert.equal(f.saves.length, 0);
    const error = f.notifications.find(item => item.kind === 'error');
    assert.equal(error.args[2].escapeHtml, true);
    assert.match(error.args[0], /送出結果不明/);
});
