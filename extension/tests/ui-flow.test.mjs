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
import * as inlineScenes from '../inline-scenes.js';
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
    conversation = async ({ initial }) => initial.prompt, manualReply = 'manual landscape, sunrise' } = {}) {
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
        saveChat: async () => { savedChats++; }, appendMediaToMessage: () => { rendered++; }, updateMessageBlock() {},
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
        if (url.endsWith('/chat/completions')) return Response.json({ choices: [{ message: { content: manualReply } }] });
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
    const button = { get: () => element, addClass() { return this; }, removeClass() { return this; }, closest: () => ({ attr: () => String(context.chat.indexOf(message)) }) };
    const toast = { find: () => ({ text() {} }) };
    const sandbox = {
        console, structuredClone, AbortController, AbortSignal, URL, ...llmPresets, ...sceneText, ...inlineScenes, runPresetTask, createLogStore, logSecrets,
        showPresetConversation: conversation,
        SillyTavern: { getContext: () => context }, $: () => ({ length: 1 }),
        toastr: Object.fromEntries(['info', 'warning', 'error', 'success', 'clear'].map(kind => [kind, (...args) => { notifications.push({ kind, args }); return toast; }])),
        MEDIA_DISPLAY: { GALLERY: 'gallery' }, MEDIA_SOURCE: { GENERATED: 'generated' }, MEDIA_TYPE: { IMAGE: 'image' }, SCROLL_BEHAVIOR: { KEEP: 'keep' },
        PROVIDER_DEFAULTS, migrateSettings, providerConnection, buildNovelPayload, normalizeToken, encryptToken, decryptToken,
        createManualLlmClient: options => createManualLlmClient({ fetchImpl: fakeFetch, ...options }), parseExtraHeaders,
        generateWithPolling: options => generateWithPolling({ ...options, delay: async signal => { await new Promise(resolve => setImmediate(resolve)); } }),
        createNovelAI: () => api, createPanelClient: connection => createPanelClient(connection, { fetchImpl: fakeFetch }),
        saveBase64AsFile: async (...args) => { saves.push(args); return `/user/images/test-${saves.length}.png`; },
    };
    vm.runInNewContext(`${source}\ngetSettings(); novelSessionToken = ${JSON.stringify(configured ? 'fake-novel-token' : '')};
        unlockedVaultFingerprint = JSON.stringify(getSettings().novelVault); novelSessionMode = 'memory';
        globalThis.api = { onMessageButtonClick, onAnalyzeButtonClick, generatePrompt, listProfiles, logs };`, sandbox, { filename: 'extension/index.js' });
    // Image transport tests start from a saved scene, just like clicking a restored tag.
    const run = (slot = 'fixture-scene') => {
        if (slot === 'fixture-scene' && !inlineScenes.inlineSlots(message).length) {
            message.mes += '\n\n[[cmi-image:fixture-scene]]';
            message.extra ??= {};
            message.extra[inlineScenes.INLINE_KEY] = { version: 1, slots: [{ id: slot, label: 'Forest', prompt: 'landscape, sunrise', images: [] }] };
        }
        return sandbox.api.onMessageButtonClick(button, slot);
    };
    return { logs: sandbox.api.logs, run, prompt: signal => sandbox.api.generatePrompt(context.chat.indexOf(message), message, signal ?? new AbortController().signal), analyze: () => sandbox.api.onAnalyzeButtonClick(button), profiles: () => sandbox.api.listProfiles(), close: () => api.close(), context, message, settings, calls, saves, notifications, prompts, reviews,
        get savedChats() { return savedChats; }, get rendered() { return rendered; } };
}

test('generation logs cover stages with no prompts, chat, credentials or image bytes by default', async t => {
    const f = fixture(); t.after(f.close);
    await f.run();
    const entries = f.logs.getEntries(), stages = entries.map(entry => entry.stage);
    for (const stage of ['start', 'prepare', 'prompt', 'submit', 'accepted', 'generation', 'download', 'save', 'attach', 'complete']) assert.ok(stages.includes(stage), stage);
    assert.equal(new Set(entries.map(entry => entry.runId)).size, 1);
    const text = JSON.stringify(entries);
    assert.doesNotMatch(text, /landscape|sunrise|forest|fake-novel-token|manual-secret-key|fake-panel-secret/);
    assert.ok(!text.includes(PNG_BASE64));
    assert.match(text, /jobId/);
});

test('detailed scene logs record payloads but mask credential echoes', async t => {
    const f = inlineFixture({ provider: 'comfy-modal', review: true }); t.after(f.close);
    f.logs.setDetailed(true);
    f.message.mes += '\n fake-panel-secret manual-secret-key';
    f.context.ConnectionManagerRequestService.sendRequest = async () => inlineReply.replace('forest, walking', 'forest, fake-panel-secret, manual-secret-key');
    await f.analyze();
    await f.run(inlineScenes.inlineSlots(f.message)[0].id);
    const text = JSON.stringify(f.logs.getEntries());
    for (const stage of ['llm.request', 'llm.response', 'image.request']) assert.ok(text.includes(stage));
    assert.match(text, /forest/); assert.match(text, /edited/);
    assert.doesNotMatch(text, /fake-panel-secret|manual-secret-key|fake-novel-token/);
    assert.ok(!text.includes(PNG_BASE64));
});

test('logs preserve analysis failure and review cancellation without image submission', async t => {
    const f = fixture(); t.after(f.close);
    f.context.ConnectionManagerRequestService.sendRequest = async () => { throw new Error('broken manual-secret-key'); };
    await f.analyze();
    assert.equal(f.calls.length, 0);
    assert.ok(f.logs.getEntries().some(entry => entry.stage === 'analysis' && entry.level === 'error'));
    assert.doesNotMatch(JSON.stringify(f.logs.getEntries()), /manual-secret-key/);
    const cancelled = fixture({ review: true }); t.after(cancelled.close);
    cancelled.context.callGenericPopup = async () => null;
    await cancelled.run();
    assert.equal(cancelled.calls.length, 0);
    assert.ok(cancelled.logs.getEntries().some(entry => entry.stage === 'cancel'));
});

test('missing scene id never falls back to whole-message generation', async t => {
    const f = fixture(); t.after(f.close);
    await f.run(null);
    assert.equal(f.calls.length, 0); assert.equal(f.prompts.length, 0); assert.equal(f.savedChats, 0);
    assert.equal(f.message.extra, undefined);
});

test('real NovelAI scene flow: direct official API, prompt review, batch metadata without gallery', async t => {
    const f = fixture({ review: true }); t.after(f.close);
    await f.run();
    const slot = inlineScenes.inlineSlots(f.message)[0];
    assert.equal(f.prompts.length, 0);
    assert.equal(f.saves.length, 2); assert.equal(f.savedChats, 1); assert.equal(f.rendered, 0);
    assert.equal(f.message.extra.media, undefined); assert.equal(slot.images.length, 2);
    assert.equal(slot.media[0].seed, '0'); assert.equal(slot.media[1].seed, '1');
    assert.equal(slot.media[0].source, 'generated'); assert.match(f.reviews[0], /NovelAI/);
    assert.match(slot.media[0].title, /edited/);
    assert.ok(!JSON.stringify(f.calls).includes('fake-panel-secret'));
    assert.ok(f.calls.every(call => call.url.startsWith('https://image.novelai.net/')));
    assert.equal(f.notifications.some(item => item.kind === 'error'), false);
});

test('manual OpenAI-compatible prompt helper uses its own model and API key without generating images', async t => {
    const f = fixture(); t.after(f.close);
    f.settings.promptConnectionMode = 'manual';
    assert.match(await f.prompt(), /manual landscape/);
    assert.equal(f.prompts.length, 0);
    const llmCall = f.calls.find(call => call.url.endsWith('/chat/completions'));
    assert.ok(llmCall);
    assert.equal(llmCall.body.model, 'manual-model');
    assert.equal(llmCall.init.headers.Authorization, 'Bearer manual-secret-key');
    assert.equal(llmCall.body.messages[0].role, 'system');
    assert.equal(f.saves.length, 0);
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
        await f.prompt();
        const body = mode === 'manual' ? f.calls.find(call => call.url.endsWith('/chat/completions')).body
            : { messages: f.prompts[0][1], max_tokens: f.prompts[0][2], ...f.prompts[0][4] };
        assert.equal(body.temperature, 0.3); assert.equal(body.max_tokens, 900);
        assert.deepEqual(JSON.parse(JSON.stringify(body.messages)), [
            { role: 'system', content: 'Draw Alice. Alice wears red. Target {{user}} literal #0' },
            { role: 'assistant', content: 'Alice: Target {{user}} literal' },
            { role: 'model', content: 'landscape,' },
            { role: 'system', content: 'PROMPT OFF Target {{user}} literal' },
        ]);
        assert.deepEqual(imported.preset.prompts.filter(item => ['prefill', 'off', 'unlisted', 'in-chat'].includes(item.identifier))
            .map(item => [item.identifier, item.role]), [['prefill', 'model'], ['off', 'unknown'], ['unlisted', 'model'], ['in-chat', 'model']]);
        assert.equal(f.saves.length, 0);
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
    const slot = inlineScenes.inlineSlots(f.message)[0];
    assert.match(submitted.body.prompt_text, /^masterpiece,/); assert.equal(slot.media[0].negative, 'blurry');
    assert.equal(slot.media[0].seed, '18446744073709551613');
    assert.equal(f.message.extra.media, undefined);
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
    await f.analyze();
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

test('legacy prompt helper keeps preset variables and conversations isolated without generating images', async t => {
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
    await f.prompt();
    assert.equal(f.prompts.length, 2); assert.equal(f.reviews.length, 0);
    assert.equal(f.prompts[1][1].at(-1).content, 'Use sunset');
    assert.equal(JSON.stringify(f.context.extensionSettings.variables), before);
    assert.equal(f.saves.length, 0);
});

test('cancelled independent dialog cannot submit an image even when normal review is disabled', async t => {
    const f = fixture({ review: false, conversation: async () => null }); t.after(f.close);
    const imported = llmPresets.importLlmPreset(JSON.stringify({ main_prompt: 'Tags' }));
    Object.assign(f.settings, { promptPresetMode: 'preset', llmPresetId: 'interactive', llmPresets: [{ id: 'interactive', ...imported, interactive: true }] });
    f.context.CONNECT_API_MAP = { cc: { selected: 'openai' } }; f.context.extensionSettings.connectionManager.profiles[0].api = 'cc';
    assert.equal(await f.prompt(), null);
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
        await f.prompt();
        const messages = JSON.stringify(f.prompts[0][1]);
        assert.doesNotMatch(messages, /NEVER READ/);
        assert.equal(messages.includes('inline thought'), cleanup === '[]');
        assert.equal(f.message.mes, 'body<thinking>inline thought</thinking>', 'Original message is never cleaned in place');
    }
});

for (const mode of ['template', 'preset']) {
    for (const connection of ['profile', 'manual']) {
        test(`${mode}/${connection}: only assistant main-chat bodies reach the LLM; preset user instructions are excluded`, async t => {
            const f = fixture(); t.after(f.close);
            Object.assign(f.settings, { promptPresetMode: mode, promptConnectionMode: connection, historyDepth: 2 });
            const references = '{{message}}|{{history}}|{{lastMessage}}|{{lastChatMessage}}|{{lastCharMessage}}|USER=[{{lastUserMessage}}]';
            f.settings.userTemplate = references;
            f.context.chat.unshift({ mes: 'EARLIER ASSISTANT', name: 'Example' },
                { is_user: true, mes: 'EXCLUDED ST USER' }, { role: 'user', mes: 'EXCLUDED ROLE USER' },
                { role: 'user', is_user: false, mes: 'EXCLUDED CONFLICTING USER' });
            f.context.chat.push({ role: 'assistant', mes: 'EXCLUDED FUTURE' });
            f.message.extra = { reasoning: 'EXCLUDED REASONING' };
            const input = f.context.chat.map(message => message.mes);
            if (mode === 'preset') {
                const imported = llmPresets.importLlmPreset(JSON.stringify({ prompts: [
                    { identifier: 'main', role: 'system', content: references },
                    { identifier: 'user-prompt', role: 'user', content: `PRESET USER INSTRUCTION ${references}` },
                    { identifier: 'chatHistory', marker: true },
                ], prompt_order: [{ character_id: 100001, order: [
                    { identifier: 'main', enabled: true }, { identifier: 'user-prompt', enabled: true }, { identifier: 'chatHistory', enabled: true },
                ] }] }));
                Object.assign(f.settings, { llmPresetId: 'test', llmPresets: [{ id: 'test', ...imported }] });
                f.context.CONNECT_API_MAP = { cc: { selected: 'openai' } };
                f.context.extensionSettings.connectionManager.profiles[0].api = 'cc';
            }
            await f.prompt();
            const messages = connection === 'profile' ? f.prompts[0]?.[1]
                : f.calls.find(call => call.url.endsWith('/chat/completions'))?.body.messages;
            assert.ok(messages, 'A prompt request must be sent');
            const text = JSON.stringify(messages);
            assert.doesNotMatch(text, /EXCLUDED/);
            assert.match(text, /EARLIER ASSISTANT/);
            assert.match(text, /bright forest clearing/);
            assert.match(text, /USER=\[\]/);
            if (mode === 'preset') {
                assert.equal(messages[0].role, 'system');
                assert.doesNotMatch(text, /PRESET USER INSTRUCTION/);
                assert.ok(messages.every(message => message.role !== 'user'));
                assert.ok(messages.slice(1).every(message => message.role === 'assistant'));
            }
            assert.deepEqual(f.context.chat.map(message => message.mes), input);
            assert.equal(f.saves.length, 0);
        });
    }
}

const inlineBody = 'A traveler enters the forest.\n\nSunset lights the lake.';
const inlineReply = JSON.stringify({ scenes: [
    { after: 'A traveler enters the forest.', label: 'Forest', prompt: '1girl, forest, walking' },
    { after: 'Sunset lights the lake.', label: 'Lake', prompt: 'lake, sunset' },
] });
function inlineFixture(options) {
    const f = fixture(options);
    f.message.mes = inlineBody;
    f.message.swipes = [inlineBody, 'OTHER SWIPE'];
    f.message.swipe_info = [{}, { extra: { untouched: true } }];
    f.context.ConnectionManagerRequestService.sendRequest = async (...args) => { f.prompts.push(args); return inlineReply; };
    return f;
}

test('manual analysis has no image-provider dependency; two slot clicks each submit only their stored prompt', async t => {
    const f = inlineFixture(); t.after(f.close);
    await f.analyze();
    assert.equal(f.prompts.length, 1); assert.equal(f.calls.length, 0); assert.equal(f.saves.length, 0);
    assert.equal(f.savedChats, 1); assert.equal(f.prompts[0][2], 2400);
    assert.match(f.prompts[0][1].at(-1).content, /ILLUSTRATION PLAN TASK/);
    const slots = f.message.extra[inlineScenes.INLINE_KEY].slots;
    assert.equal(slots.length, 2); assert.equal(f.message.swipes[0], f.message.mes);
    assert.equal(f.message.swipes[1], 'OTHER SWIPE');
    await f.run(slots[0].id);
    assert.equal(f.prompts.length, 1, 'Clicking a planned image never calls the LLM again');
    assert.equal(slots[0].images.length, 2); assert.equal(slots[1].images.length, 0);
    assert.equal(slots[0].media[0].title, '1girl, forest, walking');
    assert.equal(f.message.extra.media, undefined);
    await f.run(slots[1].id);
    assert.equal(f.prompts.length, 1); assert.equal(slots[1].images.length, 2);
    assert.equal(slots[1].media[0].title, 'lake, sunset');
    assert.equal(f.message.extra.media, undefined);
    assert.equal(f.calls.filter(call => call.url.endsWith('/ai/generate-image')).length, 2);
    assert.equal(f.message.swipe_info[0].extra[inlineScenes.INLINE_KEY].slots[1].images.length, 2);
    await f.analyze(); assert.equal(f.prompts.length, 1, 'Existing plans are not silently overwritten');
    await f.run('unknown'); assert.equal(f.calls.filter(call => call.url.endsWith('/ai/generate-image')).length, 2);
});

test('regeneration replaces only the clicked scene and leaves unrelated gallery attachments untouched', async t => {
    const f = inlineFixture(); t.after(f.close);
    await f.analyze();
    const slots = inlineScenes.inlineSlots(f.message);
    const attachment = { url: '/user/images/original.png', type: 'image', title: 'Original attachment' };
    const gallery = [attachment];
    Object.assign(f.message.extra, { media: gallery, media_index: 0, media_display: 'list', inline_image: true });
    await f.run(slots[0].id); await f.run(slots[1].id);
    const oldImages = [...slots[0].images], second = structuredClone(slots[1]);
    await f.run(slots[0].id);
    assert.equal(f.prompts.length, 1);
    assert.notDeepEqual(slots[0].images, oldImages);
    assert.equal(slots[0].images.length, 2); assert.equal(slots[0].media.length, 4);
    assert.deepEqual(structuredClone(slots[1]), second);
    assert.equal(f.message.extra.media, gallery); assert.deepEqual(gallery, [attachment]);
    assert.equal(f.message.extra.media_display, 'list'); assert.equal(f.message.extra.media_index, 0);
    assert.equal(f.rendered, 0, 'New images never invoke the native gallery renderer');
    assert.equal(f.message.swipe_info[0].extra[inlineScenes.INLINE_KEY].slots[0].media.length, 4);
    assert.deepEqual(f.message.swipe_info[1], { extra: { untouched: true } });
});

test('stopping analysis via its progress toast never submits images or changes the body', async t => {
    const f = inlineFixture(); t.after(f.close);
    f.context.ConnectionManagerRequestService.sendRequest = async () => {
        f.notifications.find(item => item.kind === 'info').args[2].onclick();
        return inlineReply;
    };
    await f.analyze();
    assert.equal(f.calls.length, 0); assert.equal(f.savedChats, 0);
    assert.equal(f.message.mes, inlineBody);
    assert.ok(f.logs.getEntries().some(entry => entry.stage === 'stop'));
    assert.equal(f.logs.getEntries().some(entry => entry.stage === 'complete'), false);
});

test('analysis works without an unlocked image token and respects imported preset without launching HTML', async t => {
    const f = inlineFixture({ configured: false, conversation: async () => { assert.fail('Analysis must not launch an HTML conversation'); } }); t.after(f.close);
    const imported = llmPresets.importLlmPreset(JSON.stringify({ main_prompt: 'PRESET STYLE {{message}}', openai_max_tokens: 700 }));
    Object.assign(f.settings, { promptPresetMode: 'preset', llmPresetId: 'inline', llmPresets: [{ id: 'inline', ...imported, interactive: true }], inlineMaxTokens: 3200 });
    f.context.CONNECT_API_MAP = { cc: { selected: 'openai' } }; f.context.extensionSettings.connectionManager.profiles[0].api = 'cc';
    await f.analyze();
    assert.equal(f.prompts.length, 1); assert.equal(f.prompts[0][2], 3200);
    assert.match(JSON.stringify(f.prompts[0][1]), /PRESET STYLE/);
    assert.equal(inlineScenes.inlineSlots(f.message).length, 2); assert.equal(f.calls.length, 0);
});

for (const presetMode of ['template', 'preset']) {
    test(`${presetMode}: manual API planning uses dedicated token budget and never submits images`, async t => {
        const f = inlineFixture({ manualReply: inlineReply, configured: false }); t.after(f.close);
        Object.assign(f.settings, { promptConnectionMode: 'manual', promptPresetMode: presetMode, inlineMaxTokens: 2800 });
        if (presetMode === 'preset') {
            const imported = llmPresets.importLlmPreset(JSON.stringify({ main_prompt: 'STYLIZED', openai_max_tokens: 700 }));
            Object.assign(f.settings, { llmPresetId: 'manual', llmPresets: [{ id: 'manual', ...imported }] });
        }
        await f.analyze();
        assert.equal(f.prompts.length, 0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].body.max_tokens, 2800);
        assert.match(f.calls[0].body.messages.at(-1).content, /ILLUSTRATION PLAN TASK/);
        assert.equal(inlineScenes.inlineSlots(f.message).length, 2); assert.equal(f.saves.length, 0);
    });
}

test('planner target obeys preset raw/prompt filters and never reintroduces excluded text', async t => {
    const f = inlineFixture(); t.after(f.close);
    f.message.mes += '\n<private>HIDDEN_BY_PRESET</private>';
    const imported = llmPresets.importLlmPreset(JSON.stringify({ main_prompt: 'Plan {{message}}', extensions: { regex_scripts: [
        { id: 'privacy', scriptName: 'privacy', findRegex: '<private>[\\s\\S]*?</private>', replaceString: '', placement: [2], promptOnly: true, markdownOnly: false, disabled: false },
    ] } }));
    Object.assign(f.settings, { promptPresetMode: 'preset', llmPresetId: 'filtered', llmPresets: [{ id: 'filtered', ...imported }] });
    f.context.CONNECT_API_MAP = { cc: { selected: 'openai' } }; f.context.extensionSettings.connectionManager.profiles[0].api = 'cc';
    await f.analyze();
    assert.equal(f.prompts.length, 1); assert.doesNotMatch(JSON.stringify(f.prompts[0][1]), /HIDDEN_BY_PRESET/);
    assert.match(f.message.mes, /HIDDEN_BY_PRESET/, 'Original text is never rewritten');
    assert.equal(inlineScenes.inlineSlots(f.message).length, 2);
});

for (const change of ['text', 'chat', 'swipe', 'message', 'invalid-json']) {
    test(`analysis discards ${change} results without inserting anything or submitting images`, async t => {
        const f = inlineFixture(); t.after(f.close);
        f.context.ConnectionManagerRequestService.sendRequest = async () => {
            if (change === 'text') f.message.mes += ' edited';
            if (change === 'chat') f.context.getCurrentChatId = () => 'OTHER';
            if (change === 'swipe') f.message.swipe_id = 1;
            if (change === 'message') f.context.chat[0] = { ...f.message };
            return change === 'invalid-json' ? 'not JSON' : inlineReply;
        };
        await f.analyze();
        assert.equal(inlineScenes.inlineSlots(f.message).length, 0); assert.equal(f.calls.length, 0);
        assert.equal(f.savedChats, 0); assert.doesNotMatch(f.message.mes, /cmi-image/);
    });
}

test('save wait chat switches are not reported as successful persistence and retain the in-memory plan', async t => {
    const f = inlineFixture(); t.after(f.close);
    f.context.saveChat = async () => { f.context.getCurrentChatId = () => 'OTHER'; };
    await f.analyze();
    assert.equal(inlineScenes.inlineSlots(f.message).length, 2);
    assert.equal(f.notifications.some(item => item.kind === 'success'), false);
    assert.equal(f.logs.getEntries().some(entry => entry.stage === 'complete'), false);
    assert.match(f.notifications.find(item => item.kind === 'error').args[0], /勿直接重整/);
    assert.equal(f.calls.length, 0);
});

test('explicit save errors keep the plan for recovery and do not retry the LLM or image API', async t => {
    const f = inlineFixture(); t.after(f.close);
    f.context.saveChat = async () => { throw new Error('ST save failed'); };
    await f.analyze();
    assert.equal(inlineScenes.inlineSlots(f.message).length, 2);
    assert.equal(f.prompts.length, 1); assert.equal(f.calls.length, 0);
    assert.equal(f.notifications.some(item => item.kind === 'success'), false);
});

test('rerendered competing controls cannot double-submit while analysis is waiting', async t => {
    const f = inlineFixture(); t.after(f.close);
    f.context.ConnectionManagerRequestService.sendRequest = async () => {
        await f.analyze(); await f.run(null); return inlineReply;
    };
    await f.analyze(); assert.equal(f.calls.length, 0); assert.equal(f.savedChats, 1);
});

test('editing during prompt review cancels before a paid image submission', async t => {
    const f = inlineFixture({ review: true }); t.after(f.close);
    await f.analyze();
    f.context.callGenericPopup = async () => { f.message.mes += ' edited'; return 'new prompt'; };
    await f.run(inlineScenes.inlineSlots(f.message)[0].id);
    assert.equal(f.calls.filter(call => call.url.endsWith('/ai/generate-image')).length, 0);
});

test('swiping during a slot image task saves files but never attaches them to a different swipe', async t => {
    const f = inlineFixture({ onSubmit: context => { context.chat[0].swipe_id = 1; } }); t.after(f.close);
    await f.analyze();
    const slot = inlineScenes.inlineSlots(f.message)[0]; await f.run(slot.id);
    assert.equal(f.saves.length, 2); assert.equal(slot.images.length, 0); assert.equal(f.message.extra.media, undefined);
    assert.equal(f.savedChats, 1);
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
