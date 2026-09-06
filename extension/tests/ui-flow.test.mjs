import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { generateWithPolling } from '../generation.js';
import { PROVIDER_DEFAULTS, SETTINGS_KEY, migrateSettings, providerConnection, buildNovelPayload } from '../providers.js';
import { createNovelAI } from '../novelai.js';
import { createPanelClient } from '../panel.js';
import { normalizeToken } from '../http.js';
import { createManualLlmClient, parseExtraHeaders } from '../manual-llm.js';
import { encryptToken, decryptToken } from '../token-vault.js';
import * as llmPresets from '../llm-presets.js';
import { PNG_BASE64, PNG_BYTES, JOB_ID, panelLogin } from './fixtures.mjs';

// Run actual button functions and both real browser transports. Only DOM/ST and
// external fetch are replaced; no server plugin, real secrets, chat writes or paid APIs.
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify('http://127.0.0.1/scripts/extensions/third-party/sillytavern-custom-text2img/index.js'))
    .replace(/\ninit\(\)\.catch\([^\n]+\);\s*$/, '');
assert.ok(!source.includes('init().catch'));

function fixture({ provider = 'novelai', configured = true, onSubmit = () => {}, replyError = false, review = false } = {}) {
    const calls = [], saves = [], notifications = [], prompts = [], reviews = [];
    const settings = { ...PROVIDER_DEFAULTS, provider, enabled: true, promptConnectionMode: 'profile', profileId: 'independent', reviewPrompt: review,
        manualLlmBaseUrl: 'https://llm.example/v1', manualLlmPath: 'chat/completions', manualLlmModel: 'manual-model',
        manualLlmApiKey: 'manual-secret-key', manualLlmApiKeyHeader: 'Authorization', manualLlmApiKeyPrefix: 'Bearer', manualLlmExtraHeaders: '',
        baseUrl: 'https://panel.trycloudflare.com', password: 'fake-panel-secret', panelPreset: 'read-only',
        seed: '18446744073709551613', novelBatchSize: 2 };
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
    const fakeFetch = async (url, init) => {
        const body = init?.body ? JSON.parse(init.body) : {};
        calls.push({ url, body, init });
        if (url.endsWith('/api/browser/login')) return panelLogin();
        if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: 'manual landscape, sunrise' } }] });
        if (url.endsWith('/presets/read-only')) return Response.json({ prompts: { positive: 'masterpiece', negative: 'blurry' }, loras: [{ name: 'test-lora' }] });
        if (url.endsWith('/generate/jobs') || url.endsWith('/ai/generate-image')) {
            onSubmit(context);
            if (replyError) throw new TypeError('<b>lost upstream response</b>');
            if (url.startsWith('https://image.novelai.net/')) return Response.json({ images: [{ image: PNG_BASE64, seed: 0 }, { image: PNG_BASE64, seed: 1 }] });
            return Response.json({ job_id: JOB_ID, next_cursor: 1, finished: true,
                events: [{ type: 'done', seed: '18446744073709551613', images: ['1/0.png', '1/1.png'] }] }, { status: 202 });
        }
        if (url.includes('/api/browser/output/')) return new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/png' } });
        assert.fail(`Unexpected UI request (ST plugin endpoints are forbidden): ${url}`);
    };
    const api = createNovelAI({ fetchImpl: fakeFetch, locks: null });
    const element = {};
    const button = { get: () => element, addClass() { return this; }, removeClass() { return this; }, closest: () => ({ attr: () => '0' }) };
    const toast = { find: () => ({ text() {} }) };
    const sandbox = {
        console, structuredClone, AbortController, AbortSignal, URL, ...llmPresets,
        SillyTavern: { getContext: () => context }, $: () => ({ length: 1 }),
        toastr: Object.fromEntries(['info', 'warning', 'error', 'success', 'clear'].map(kind => [kind, (...args) => { notifications.push({ kind, args }); return toast; }])),
        MEDIA_DISPLAY: { GALLERY: 'gallery' }, MEDIA_SOURCE: { GENERATED: 'generated' }, MEDIA_TYPE: { IMAGE: 'image' }, SCROLL_BEHAVIOR: { KEEP: 'keep' },
        PROVIDER_DEFAULTS, migrateSettings, providerConnection, buildNovelPayload, normalizeToken, encryptToken, decryptToken,
        createManualLlmClient: options => createManualLlmClient({ fetchImpl: fakeFetch, ...options }), parseExtraHeaders,
        generateWithPolling: options => generateWithPolling({ ...options, delay: async signal => { await new Promise(resolve => setImmediate(resolve)); } }),
        createNovelAI: () => api, createPanelClient: connection => createPanelClient(connection, { fetchImpl: fakeFetch }),
        saveBase64AsFile: async (...args) => { saves.push(args); return `/images/test-${saves.length}.png`; },
    };
    vm.runInNewContext(`${source}\ngetSettings(); novelSessionToken = ${JSON.stringify(configured ? 'fake-novel-token' : '')};
        unlockedVaultFingerprint = JSON.stringify(getSettings().novelVault); novelSessionMode = 'memory';
        globalThis.api = { onMessageButtonClick, listProfiles };`, sandbox, { filename: 'extension/index.js' });
    return { run: () => sandbox.api.onMessageButtonClick(button), profiles: () => sandbox.api.listProfiles(), close: () => api.close(), context, message, settings, calls, saves, notifications, prompts, reviews,
        get savedChats() { return savedChats; }, get rendered() { return rendered; } };
}

test('real NovelAI button flow: direct official API, independent profile, prompt review, multiple gallery images', async t => {
    const f = fixture({ review: true }); t.after(f.close);
    await f.run();
    assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0][0], 'independent'); assert.equal(f.prompts[0][3].includePreset, true);
    assert.equal(f.saves.length, 2); assert.equal(f.savedChats, 1); assert.equal(f.rendered, 1);
    assert.equal(f.message.extra.media.length, 2);
    assert.equal(f.message.extra.media[0].seed, '0'); assert.equal(f.message.extra.media[1].seed, '1');
    assert.equal(f.message.extra.media[0].source, 'generated'); assert.match(f.reviews[0], /NovelAI/);
    assert.match(f.message.extra.media[0].title, /edited/);
    assert.ok(!JSON.stringify(f.calls).includes('fake-panel-secret'));
    assert.ok(f.calls.every(call => call.url.startsWith('https://image.novelai.net/')));
    assert.equal(f.notifications.some(item => item.kind === 'error'), false);
});

test('manual OpenAI-compatible prompt mode bypasses Connection Manager and uses its own model and API key', async t => {
    const f = fixture(); t.after(f.close);
    f.settings.promptConnectionMode = 'manual';
    await f.run();
    assert.equal(f.prompts.length, 0);
    const llmCall = f.calls.find(call => call.url.endsWith('/chat/completions'));
    assert.ok(llmCall);
    assert.equal(llmCall.body.model, 'manual-model');
    assert.equal(llmCall.init.headers.Authorization, 'Bearer manual-secret-key');
    assert.equal(llmCall.body.messages[0].role, 'system');
    assert.match(f.message.extra.media[0].title, /manual landscape/);
});

for (const mode of ['manual', 'profile']) {
    test(`imported LLM preset drives real ${mode} button request with scoped macros and sampling`, async t => {
        const f = fixture(); t.after(f.close);
        const imported = llmPresets.importLlmPreset(JSON.stringify({
            temperature: 0.3, openai_max_tokens: 900, custom_url: 'https://evil.invalid',
            prompts: [
                { identifier: 'main', role: 'system', content: 'Draw {{char}}. {{description}}. {{lastMessage}} #{{lastMessageId}}' },
                { identifier: 'chatHistory', marker: true },
                { identifier: 'jailbreak', role: 'user', content: 'Tags only' },
                { identifier: 'prefill', role: 'model', content: 'landscape,' },
                { identifier: 'off', role: 'unknown', content: 'disabled' },
                { identifier: 'unlisted', role: 'model', content: 'UNLISTED' },
                { identifier: 'in-chat', role: 'model', content: 'IGNORED IN-CHAT', injection_position: 1, injection_depth: 0 },
            ],
            prompt_order: [{ character_id: 100001, order: [
                { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
                { identifier: 'jailbreak', enabled: true }, { identifier: 'prefill', enabled: true },
                { identifier: 'off', enabled: false }, { identifier: 'in-chat', enabled: true },
            ] }],
        }), 'image.json');
        Object.assign(f.settings, { promptConnectionMode: mode, promptPresetMode: 'preset', llmPresetId: 'test', llmPresets: [{ id: 'test', ...imported }] });
        f.context.groupId = 'group'; f.context.name2 = 'Bob'; f.context.name1 = 'User';
        f.context.characters = [{ name: 'Alice', avatar: 'alice.png', description: '{{char}} wears red' }, { name: 'Bob' }];
        f.message.name = 'Alice'; f.message.original_avatar = 'alice.png';
        f.message.mes = 'Target {{user}} literal';
        f.context.chat.push({ mes: 'FUTURE CONTENT', name: 'Bob' });
        f.context.substituteParamsExtended = text => text.replaceAll('{{char}}', 'Bob').replaceAll('{{lastMessage}}', 'FUTURE CONTENT');
        f.context.CONNECT_API_MAP = { cc: { selected: 'openai' } };
        f.context.extensionSettings.connectionManager.profiles[0].api = 'cc';
        await f.run();
        const body = mode === 'manual' ? f.calls.find(call => call.url.endsWith('/chat/completions')).body
            : { messages: f.prompts[0][1], max_tokens: f.prompts[0][2], ...f.prompts[0][4] };
        assert.equal(body.temperature, 0.3); assert.equal(body.max_tokens, 900);
        assert.deepEqual(JSON.parse(JSON.stringify(body.messages)), [
            { role: 'system', content: 'Draw Alice. Alice wears red. Target {{user}} literal #0' },
            { role: 'assistant', content: 'Alice: Target {{user}} literal' }, { role: 'user', content: 'Tags only' },
            { role: 'model', content: 'landscape,' },
        ]);
        assert.deepEqual(imported.preset.prompts.filter(item => ['prefill', 'off', 'unlisted', 'in-chat'].includes(item.identifier))
            .map(item => [item.identifier, item.role]), [['prefill', 'model'], ['off', 'unknown'], ['unlisted', 'model'], ['in-chat', 'model']]);
        assert.equal(f.saves.length, 2);
        assert.equal(f.settings.systemPrompt.includes('expert prompt engineer'), true);
        assert.doesNotMatch(JSON.stringify(f.calls), /evil.invalid|FUTURE CONTENT/);
        if (mode === 'profile') assert.equal(f.prompts[0][3].includePreset, true);
    });
}

test('real panel flow preserves presets, LoRAs, 64-bit seed and frozen connection after switching settings', async t => {
    const f = fixture({ provider: 'comfy-modal', onSubmit(context) {
        const settings = context.extensionSettings[SETTINGS_KEY];
        settings.provider = 'novelai'; settings.password = 'changed'; settings.baseUrl = 'https://other.invalid';
    } }); t.after(f.close);
    await f.run();
    assert.equal(f.savedChats, 1);
    const submitted = f.calls.find(call => call.url.endsWith('/generate/jobs'));
    assert.equal(submitted.body.seed, '18446744073709551613'); assert.equal(submitted.body.loras[0].name, 'test-lora');
    assert.match(submitted.body.prompt_text, /^masterpiece,/); assert.equal(f.message.extra.media[0].negative, 'blurry');
    assert.equal(f.message.extra.media[0].seed, '18446744073709551613');
    for (const call of f.calls) {
        assert.ok(call.url.startsWith('https://panel.trycloudflare.com/api/browser/'));
        assert.equal(call.init.credentials, 'omit'); assert.ok(!JSON.stringify(call).includes('fake-novel-token'));
        if (!call.url.endsWith('/login')) assert.ok(!JSON.stringify(call).includes('fake-panel-secret'));
    }
});

test('ST 1.14 profile checker errors only skip newer unsupported profiles', async t => {
    const f = fixture(); t.after(f.close);
    f.context.extensionSettings.connectionManager.profiles.push({ id: 'newer-provider' });
    f.context.ConnectionManagerRequestService.isProfileSupported = profile => {
        if (profile.id === 'newer-provider') throw new TypeError('Unknown provider in this ST release');
        return profile.id === 'independent';
    };
    assert.deepEqual(f.profiles().map(profile => profile.id), ['independent']);
});

test('missing selected preset fails before any paid request instead of falling back to templates', async t => {
    const f = fixture(); t.after(f.close);
    f.settings.promptPresetMode = 'preset'; f.settings.llmPresetId = 'missing';
    await f.run();
    assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0);
    assert.ok(f.notifications.some(item => item.kind === 'error' && item.args[0].includes('預設不存在')));
});

test('missing/locked NovelAI token fails before any LLM, generation or image save', async t => {
    const f = fixture({ configured: false }); t.after(f.close);
    await f.run();
    assert.equal(f.prompts.length, 0); assert.equal(f.saves.length, 0); assert.equal(f.savedChats, 0); assert.equal(f.calls.length, 0);
    assert.ok(f.notifications.some(item => item.kind === 'error' && item.args[0].includes('Token')));
});

test('replacing account vault data locks the old in-memory token before generation', async t => {
    const f = fixture(); t.after(f.close);
    f.settings.novelVault = { ciphertext: 'another user or token' };
    await f.run();
    assert.equal(f.prompts.length, 0); assert.equal(f.calls.length, 0);
});

test('a changed message is never replaced or attached to after generation', async t => {
    const f = fixture({ onSubmit(context) { context.chat[0] = { mes: 'a different message' }; } }); t.after(f.close);
    await f.run();
    assert.equal(f.saves.length, 2); assert.equal(f.savedChats, 0); assert.equal(f.context.chat[0].extra, undefined);
    assert.ok(f.notifications.some(item => item.kind === 'warning'));
});

for (const provider of ['novelai', 'comfy-modal']) {
    test(`${provider}: a lost submit response is not retried and errors are rendered as text`, async t => {
        const f = fixture({ provider, replyError: true }); t.after(f.close);
        await f.run();
        assert.equal(f.calls.filter(call => call.url.endsWith('/generate/jobs') || call.url.endsWith('/ai/generate-image')).length, 1);
        assert.equal(f.saves.length, 0);
        const error = f.notifications.find(item => item.kind === 'error');
        assert.equal(error.args[2].escapeHtml, true); assert.doesNotMatch(error.args[0], /<b>/);
        assert.match(error.args[0], provider === 'novelai' ? /不會自動重送/ : /送出結果不明/);
    });
}
