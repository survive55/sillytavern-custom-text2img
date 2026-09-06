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
import * as sceneText from '../scene-text.js';
import { createPresetState, preparePresetRequest, acceptPresetResponse } from '../preset-runtime.js';

// Exercise real pure worker operations here; browser smoke verifies actual Worker isolation.
async function runPresetTask(type, payload, signal) {
    signal?.throwIfAborted();
    if (type === 'clean') return sceneText.cleanScene(payload.snapshot, payload.bodyCleanupRules);
    if (type === 'create') return createPresetState(payload);
    if (type === 'prepare') return preparePresetRequest(payload.state, payload.userText);
    if (type === 'accept') return acceptPresetResponse(payload.state, payload.content);
    throw new Error(`Unknown worker test operation: ${type}`);
}
import { createLogStore, logSecrets } from '../logs.js';
import { PNG_BASE64, PNG_BYTES, JOB_ID, panelLogin } from './fixtures.mjs';

// Run actual button functions and both real browser transports. Only DOM/ST and
// external fetch are replaced; no server plugin, real secrets, chat writes or paid APIs.
const source = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8')
    .replace(/^import .*;\r?\n/gm, '')
    .replaceAll('import.meta.url', JSON.stringify('http://127.0.0.1/scripts/extensions/third-party/sillytavern-custom-text2img/index.js'))
    .replace(/\ninit\(\)\.catch\([^\n]+\);\s*$/, '');
assert.ok(!source.includes('init().catch'));

function fixture({ provider = 'novelai', configured = true, onSubmit = () => {}, replyError = false, review = false,
    conversation = async ({ initial }) => initial.prompt } = {}) {
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
        console, structuredClone, AbortController, AbortSignal, URL, ...llmPresets, ...sceneText, runPresetTask, createLogStore, logSecrets,
        showPresetConversation: conversation,
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
        globalThis.api = { onMessageButtonClick, listProfiles, logs };`, sandbox, { filename: 'extension/index.js' });
    return { logs: sandbox.api.logs, run: () => sandbox.api.onMessageButtonClick(button), profiles: () => sandbox.api.listProfiles(), close: () => api.close(), context, message, settings, calls, saves, notifications, prompts, reviews,
        get savedChats() { return savedChats; }, get rendered() { return rendered; } };
}

test('generation logs cover stages with no prompts, chat, credentials or image bytes by default', async t => {
    const f = fixture(); t.after(f.close);
    await f.run();
    const entries = f.logs.getEntries(), stages = entries.map(entry => entry.stage);
    for (const stage of ['start', 'prepare', 'llm', 'submit', 'accepted', 'generation', 'download', 'save', 'attach', 'complete']) assert.ok(stages.includes(stage), stage);
    assert.equal(new Set(entries.map(entry => entry.runId)).size, 1);
    const text = JSON.stringify(entries);
    assert.doesNotMatch(text, /landscape|sunrise|forest|fake-novel-token|manual-secret-key|fake-panel-secret/);
    assert.ok(!text.includes(PNG_BASE64));
    assert.match(text, /jobId/);
});

test('detailed generation logs record request, raw response and final payload but mask credential echoes', async t => {
    const f = fixture({ provider: 'comfy-modal', review: true }); t.after(f.close);
    f.logs.setDetailed(true);
    f.message.mes += ' fake-panel-secret manual-secret-key';
    f.context.ConnectionManagerRequestService.sendRequest = async () => 'landscape, fake-panel-secret, manual-secret-key';
    await f.run();
    const text = JSON.stringify(f.logs.getEntries());
    assert.match(text, /llm.request|llm.response|image.request/);
    assert.match(text, /landscape/); assert.match(text, /edited/); assert.match(text, /forest clearing/);
    assert.doesNotMatch(text, /fake-panel-secret|manual-secret-key|fake-novel-token/);
    assert.ok(!text.includes(PNG_BASE64));
});

test('logs preserve failure stage and cancellation without any image submit', async t => {
    const f = fixture(); t.after(f.close);
    f.context.ConnectionManagerRequestService.sendRequest = async () => { throw new Error('broken manual-secret-key'); };
    await f.run();
    assert.equal(f.calls.length, 0);
    assert.ok(f.logs.getEntries().some(entry => entry.stage === 'llm' && entry.level === 'error'));
    assert.doesNotMatch(JSON.stringify(f.logs.getEntries()), /manual-secret-key/);
    const cancelled = fixture({ review: true }); t.after(cancelled.close);
    cancelled.context.callGenericPopup = async () => null;
    await cancelled.run();
    assert.equal(cancelled.calls.length, 0);
    assert.ok(cancelled.logs.getEntries().some(entry => entry.stage === 'cancel'));
});

test('stopping LLM waiting is a warning and never submits an image request', async t => {
    const f = fixture(); t.after(f.close);
    f.context.ConnectionManagerRequestService.sendRequest = async () => { await f.run(); return 'landscape'; };
    await f.run();
    assert.equal(f.calls.length, 0);
    assert.ok(f.logs.getEntries().some(entry => entry.stage === 'stop' && entry.level === 'warn'));
    assert.equal(f.logs.getEntries().some(entry => entry.stage === 'complete'), false);
});

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
                { identifier: 'off', role: 'unknown', content: 'disabled', enabled: true },
                { identifier: 'prompt-off', role: 'system', content: 'PROMPT OFF {{lastMessage}}', enabled: false },
                { identifier: 'in-chat-off', role: 'user', content: 'DEPTH OFF', enabled: false, injection_position: 1, injection_depth: 0 },
                { identifier: 'unlisted', role: 'model', content: 'UNLISTED' },
                { identifier: 'in-chat', role: 'model', content: 'IGNORED IN-CHAT', injection_position: 1, injection_depth: 0 },
            ],
            prompt_order: [{ character_id: 100001, order: [
                { identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true },
                { identifier: 'jailbreak', enabled: true }, { identifier: 'prefill', enabled: true },
                { identifier: 'off', enabled: false }, { identifier: 'in-chat', enabled: true },
                { identifier: 'prompt-off', enabled: true }, { identifier: 'in-chat-off', enabled: true },
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

test('preset variables never call ST macros and interactive mode always confirms images', async t => {
    const f = fixture({ review: false, conversation: async ({ initial, onTurn, signal }) => {
        assert.equal(initial.raw, 'landscape, sunrise');
        const next = await onTurn('Use sunset', signal);
        return next.prompt;
    } }); t.after(f.close);
    const imported = llmPresets.importLlmPreset(JSON.stringify({ main_prompt: '{{setvar::x::private}}{{getvar::x}} {{lastMessage}}' }));
    Object.assign(f.settings, { promptPresetMode: 'preset', llmPresetId: 'interactive', llmPresets: [{ id: 'interactive', ...imported, interactive: true }] });
    f.context.CONNECT_API_MAP = { cc: { selected: 'openai' } }; f.context.extensionSettings.connectionManager.profiles[0].api = 'cc';
    f.context.substituteParamsExtended = () => { throw new Error('Must not call ST macro engine'); };
    const before = JSON.stringify(f.context.extensionSettings.variables);
    await f.run();
    assert.equal(f.prompts.length, 2); assert.equal(f.reviews.length, 1);
    assert.equal(f.prompts[1][1].at(-1).content, 'Use sunset');
    assert.equal(JSON.stringify(f.context.extensionSettings.variables), before);
    assert.equal(f.saves.length, 2);
});

test('cancelled independent dialog cannot submit an image even when normal review is disabled', async t => {
    const f = fixture({ review: false, conversation: async () => null }); t.after(f.close);
    const imported = llmPresets.importLlmPreset(JSON.stringify({ main_prompt: 'Tags' }));
    Object.assign(f.settings, { promptPresetMode: 'preset', llmPresetId: 'interactive', llmPresets: [{ id: 'interactive', ...imported, interactive: true }] });
    f.context.CONNECT_API_MAP = { cc: { selected: 'openai' } }; f.context.extensionSettings.connectionManager.profiles[0].api = 'cc';
    await f.run();
    assert.equal(f.prompts.length, 1); assert.equal(f.saves.length, 0); assert.equal(f.calls.length, 0);
});

test('template scene macros use assistant mes only and cleanup is opt-in', async t => {
    for (const cleanup of ['[]', sceneText.DEFAULT_BODY_CLEANUP]) {
        const f = fixture(); t.after(f.close);
        f.settings.bodyCleanupRules = cleanup;
        f.message.mes = 'body<thinking>inline thought</thinking>';
        f.message.extra = { reasoning: 'NEVER READ REASONING' };
        f.settings.userTemplate = '{{message}}|{{lastMessage}}|{{lastCharMessage}}|{{lastUserMessage}}';
        f.context.chat.push({ is_user: true, mes: 'NEVER READ USER' });
        await f.run();
        const messages = JSON.stringify(f.prompts[0][1]);
        assert.doesNotMatch(messages, /NEVER READ/);
        assert.equal(messages.includes('inline thought'), cleanup === '[]');
        assert.equal(f.message.mes, 'body<thinking>inline thought</thinking>', 'Original message is never cleaned in place');
    }
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
