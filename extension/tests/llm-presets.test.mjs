import assert from 'node:assert/strict';
import { test } from 'node:test';
import { importLlmPreset, normalizeLlmPreset, buildPresetMessages, getPresetOrder, presetSampling,
    collectPresetHistory, sendPromptRequest, LLM_PRESET_DEFAULTS, MAX_PRESET_BYTES } from '../llm-presets.js';
import { SETTINGS_KEY, LEGACY_SETTINGS_KEY, migrateSettings } from '../providers.js';

const p = (identifier, content = identifier, extra = {}) => ({ identifier, role: 'system', content, ...extra });
const o = (identifier, enabled = true) => ({ identifier, enabled });
const fixture = (prompts, order = prompts.map(item => o(item.identifier)), extra = {}) => ({
    prompts, prompt_order: [{ character_id: 100001, order }], ...extra,
});
const history = [{ role: 'user', content: 'Before' }, { role: 'assistant', content: 'Scene' }];
const build = (raw, extra = {}) => buildPresetMessages(normalizeLlmPreset(raw).preset, { history, ...extra });

test('CC uses order.enabled and order identifiers, not storage order or prompt.enabled', () => {
    const raw = fixture([p('phi', 'Tags only'), p('off'), p('unlisted'), p('main', 'Draw', { enabled: false }), p('chatHistory', 'must not be sent', { marker: true })],
        [o('main'), o('off', false), o('chatHistory'), o('phi')]);
    const before = structuredClone(raw);
    assert.deepEqual(build(raw), [{ role: 'system', content: 'Draw' }, ...history, { role: 'system', content: 'Tags only' }]);
    assert.deepEqual(raw, before);
});

test('quiet triggers are respected, including a disabled main replacement', () => {
    const raw = fixture([p('main', 'normal only', { injection_trigger: ['normal'] }),
        p('quiet', 'tags', { injection_trigger: ['quiet'] }), p('chatHistory', '', { marker: true }), p('all', 'all')]);
    assert.deepEqual(build(raw), [{ role: 'system', content: 'tags' }, ...history, { role: 'system', content: 'all' }]);
});

test('legacy main/nsfw/PHI migrate before building, including intentionally empty strings', () => {
    const raw = { main_prompt: 'Render tags', nsfw_prompt: '', jailbreak_prompt: 'Only tags', temperature: '0', openai_max_tokens: 768 };
    const { preset, orderId } = importLlmPreset(JSON.stringify(raw), 'my-preset.json');
    assert.equal(orderId, '100001'); assert.equal(preset.temperature, 0); assert.equal(preset.openai_max_tokens, 768);
    assert.deepEqual(buildPresetMessages(preset, { history }), [{ role: 'system', content: 'Render tags' }, ...history, { role: 'system', content: 'Only tags' }]);
    assert.deepEqual(build({ ...raw, main_prompt: '' }), [...history, { role: 'system', content: 'Only tags' }]);
});

test('missing prompt_order uses ST built-in order without activating arbitrary custom prompts', () => {
    const { preset, warnings } = normalizeLlmPreset({ prompts: [p('jailbreak'), p('custom'), p('main')] });
    assert.ok(warnings.some(message => message.includes('未提供 prompt_order')));
    assert.deepEqual(buildPresetMessages(preset, { history }), [p('main'), ...history, p('jailbreak')].map(({ role, content }) => ({ role, content })));
});

test('Prompt Manager version 1 exports use nested data and a flat active order', () => {
    for (const type of ['full', 'character']) {
        const imported = importLlmPreset('\uFEFF' + JSON.stringify({ version: 1, type, data: {
            prompts: [p('a'), p('b')], prompt_order: [o('b'), o('a', false)],
        } }), 'nested.json');
        assert.equal(imported.name, 'nested');
        assert.deepEqual(buildPresetMessages(imported.preset, { history: [] }), [{ role: 'system', content: 'b' }]);
    }
});

test('global 100001 wins over legacy dummy 100000; ambiguous character orders require selection', () => {
    const raw = fixture([p('a'), p('b')]);
    raw.prompt_order = [{ character_id: 100000, order: [o('a')] }, { character_id: 100001, order: [o('b')] }];
    assert.equal(normalizeLlmPreset(raw).orderId, '100001');
    assert.deepEqual(build(raw, { history: [] }), [{ role: 'system', content: 'b' }]);
    raw.prompt_order[1].character_id = 7;
    assert.equal(normalizeLlmPreset(raw).orderId, '');
    assert.throws(() => build(raw), /character_id/);
    assert.deepEqual(build(raw, { history: [], orderId: '7' }), [{ role: 'system', content: 'b' }]);
    assert.throws(() => getPresetOrder(normalizeLlmPreset(raw).preset, 'missing'), /character_id/);
});

test('missing standard markers are materialized, custom dangling identifiers are skipped with warning', () => {
    const { preset, warnings } = normalizeLlmPreset(fixture([p('main')], [o('main'), o('chatHistory'), o('missing')]));
    assert.deepEqual(buildPresetMessages(preset, { history }), [{ role: 'system', content: 'main' }, ...history]);
    assert.ok(warnings.some(message => message.includes('missing')));
});

test('duplicate prompts keep last definition, duplicate order entries and invalid enabled are rejected', () => {
    const { preset, warnings } = normalizeLlmPreset(fixture([p('a', 'old'), p('a', 'new')], [o('a')]));
    assert.equal(preset.prompts[0].content, 'new'); assert.equal(warnings.length, 1);
    assert.throws(() => normalizeLlmPreset(fixture([p('a')], [o('a'), o('a')])), /重複/);
    assert.throws(() => normalizeLlmPreset(fixture([p('a')], [{ identifier: 'a', enabled: 'false' }])), /布林/);
    assert.deepEqual(build(fixture([p('a'), p('chatHistory')], [{ identifier: 'a' }, o('chatHistory')])), history);
});

test('in-chat depth counts original messages and group priority matches ST reversed history', () => {
    const raw = fixture([p('main'), p('chatHistory', '', { marker: true }),
        p('last', 'depth0', { injection_position: 1, injection_depth: 0 }),
        p('one', 'depth1', { role: 'user', injection_position: 1, injection_depth: 1 }),
        p('deep', 'deep', { injection_position: 1, injection_depth: 4 }),
        p('same', 'second', { injection_position: 1, injection_depth: 0 }),
        p('early', 'priority', { role: 'assistant', injection_position: 1, injection_depth: 0, injection_order: 10 }),
        p('user', 'user', { role: 'user', injection_position: 1, injection_depth: 0 }), p('phi')]);
    assert.deepEqual(build(raw), [
        { role: 'system', content: 'main' }, { role: 'system', content: 'deep' }, history[0],
        { role: 'user', content: 'depth1' }, history[1], { role: 'assistant', content: 'priority' },
        { role: 'user', content: 'user' }, { role: 'system', content: 'depth0\nsecond' }, { role: 'system', content: 'phi' },
    ]);
});

test('history off stays off and no marker names or marker content are sent as text', () => {
    const raw = fixture([p('main'), p('chatHistory', 'DO NOT SEND'), p('worldInfoBefore', 'STALE'),
        p('unknownMarker', 'BAD', { marker: true }), p('at-depth', 'hidden', { injection_position: 1, injection_depth: 0 })],
    [o('main'), o('chatHistory', false), o('worldInfoBefore'), o('unknownMarker'), o('at-depth')]);
    assert.deepEqual(build(raw), [{ role: 'system', content: 'main' }]);
});

test('partial presets insert scene before PHI without evaluating macros twice', () => {
    const calls = [];
    const result = build(fixture([p('main'), p('jailbreak', 'PHI')]), { expand: text => { calls.push(text); return text; } });
    assert.deepEqual(result, [{ role: 'system', content: 'main' }, ...history, { role: 'system', content: 'PHI' }]);
    assert.deepEqual(calls, ['main', 'PHI']);
});

test('character/persona/scenario markers, role overrides, formats and examples are resolved', () => {
    const raw = fixture([p('charDescription', 'marker'), p('charPersonality', '', { role: 'user' }),
        p('scenario'), p('personaDescription'), p('dialogueExamples'), p('chatHistory')], undefined,
    { personality_format: 'Personality: {{personality}}', scenario_format: 'Scene: {{scenario}}', new_chat_prompt: 'NEW', new_example_chat_prompt: 'EXAMPLE' });
    const fields = { description: 'Traveler', personality: 'calm', scenario: 'forest', persona: 'User persona', mesExamples: '<START>\nUser: hello\nTraveler: hi\nthere' };
    assert.deepEqual(build(raw, { fields, char: 'Traveler', user: 'User', expand: text => text.replace('{{personality}}', 'calm').replace('{{scenario}}', 'forest') }), [
        { role: 'system', content: 'Traveler' }, { role: 'user', content: 'Personality: calm' },
        { role: 'system', content: 'Scene: forest' }, { role: 'system', content: 'User persona' },
        { role: 'system', content: 'EXAMPLE' }, { role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi\nthere' },
        { role: 'system', content: 'NEW' }, ...history,
    ]);
});

test('history selection excludes system messages, blank messages and messages after the target', () => {
    const chat = [{ mes: 'older', is_user: true }, { mes: 'system', is_system: true }, { mes: '' }, { mes: '{{user}} literal scene' }, { mes: 'future' }];
    assert.deepEqual(collectPresetHistory(chat, 3, 1), [{ role: 'user', content: 'older' }, { role: 'assistant', content: '{{user}} literal scene' }]);
    assert.equal(collectPresetHistory(chat, 3, 0).length, 1);
});

test('group examples and history preserve each speaker rather than merging into the user', () => {
    const raw = fixture([p('dialogueExamples'), p('chatHistory')]);
    const messages = build(raw, { char: 'Alice', user: 'User', groupNames: ['Alice', 'Bob'], history: [],
        fields: { mesExamples: '<START>\nUser: Hello\nBob: Hi Bob\nAlice: Hi Alice' } });
    assert.deepEqual(messages, [{ role: 'user', content: 'User: Hello' },
        { role: 'assistant', content: 'Bob: Hi Bob' }, { role: 'assistant', content: 'Alice: Hi Alice' }]);
    assert.deepEqual(collectPresetHistory([{ name: 'Bob', mes: 'earlier' }, { name: 'Alice', mes: 'scene' }], 1, 2, true), [
        { role: 'assistant', content: 'Bob: earlier' }, { role: 'assistant', content: 'Alice: scene' },
    ]);
});

test('invalid and unsupported import formats fail atomically without modifying the source', () => {
    for (const raw of [[], null, {}, { prompts: { positive: 'panel' } }, { input_sequence: 'instruct' },
        { temperature: 1 }, { version: 2, type: 'full', data: {} }, fixture([p('x', {}, {})]),
        fixture([p('x', '', { role: 'tool' })]), fixture([p('x', '', { injection_position: 9 })])]) {
        assert.throws(() => normalizeLlmPreset(raw), /LLM 預設/);
    }
    assert.throws(() => importLlmPreset('{'), /有效的 JSON/);
    assert.throws(() => importLlmPreset(' '.repeat(MAX_PRESET_BYTES + 1)), /2 MiB/);
    assert.throws(() => build(fixture([p('x')], [o('x', false)]), { history: [] }), /沒有任何/);
});

test('sampling allowlist supports old names and zero, excludes secrets/routing/tools and random seed -1', () => {
    const raw = fixture([p('main')], undefined, { temp_openai: 0, top_p: 0.8, frequency_penalty: -1, presence_penalty: 0,
        seed: -1, model: 'untrusted', custom_url: 'https://untrusted.invalid', proxy_password: 'secret',
        custom_include_headers: 'Authorization: secret', custom_include_body: 'messages: []', stream: true, n: 99,
        extensions: { executable: 'not run' }, function_calling: true });
    const imported = normalizeLlmPreset(raw);
    assert.deepEqual(presetSampling(imported.preset), { temperature: 0, top_p: 0.8, frequency_penalty: -1, presence_penalty: 0 });
    assert.doesNotMatch(JSON.stringify(imported.preset), /secret|untrusted|executable|Authorization/);
    assert.ok(imported.warnings.some(message => message.includes('不執行')));
    for (const value of [null, {}, '', Infinity, 'nan', 3]) assert.throws(() => presetSampling({ temperature: value }), /LLM 預設/);
});

test('new defaults preserve legacy and current settings without enabling presets or sharing arrays', () => {
    const old = { profileId: 'profile', systemPrompt: 'my system', userTemplate: 'my scene', panelPreset: 'image-settings',
        manualLlmApiKey: 'secret', promptConnectionMode: 'manual', maxTokens: 222, novelSeed: '0' };
    const defaults = { ...old, ...LLM_PRESET_DEFAULTS };
    for (const key of [SETTINGS_KEY, LEGACY_SETTINGS_KEY]) {
        const container = { [key]: structuredClone(old) };
        const { settings } = migrateSettings(container, defaults);
        for (const [field, value] of Object.entries(old)) assert.equal(settings[field], value);
        assert.equal(settings.promptPresetMode, 'template'); assert.deepEqual(settings.llmPresets, []);
        assert.equal(migrateSettings(container, defaults).changed, false);
        assert.notEqual(settings.llmPresets, LLM_PRESET_DEFAULTS.llmPresets);
    }
    const selected = { ...old, promptPresetMode: 'preset', llmPresetId: 'saved', llmPresets: [{ id: 'saved' }] };
    const settings = migrateSettings({ [SETTINGS_KEY]: selected }, defaults).settings;
    assert.equal(settings.llmPresetId, 'saved'); assert.deepEqual(settings.llmPresets, [{ id: 'saved' }]);
});

test('both transports apply preset samplers, profile keeps independent route and disables double preset', async () => {
    const calls = [], manual = [];
    const context = { CONNECT_API_MAP: { cc: { selected: 'openai' }, tc: { selected: 'textgenerationwebui' } },
        extensionSettings: { connectionManager: { profiles: [{ id: 'profile', api: 'cc' }] } },
        ConnectionManagerRequestService: { sendRequest: async (...args) => { calls.push(args); return { content: 'tags' }; } } };
    const manualLlm = { send: async (...args) => { manual.push(args); return 'tags'; } };
    const settings = { profileId: 'profile', promptConnectionMode: 'profile' }, signal = new AbortController().signal;
    const args = { settings, context, manualLlm, messages: history, maxTokens: 800, signal, preset: { temperature: 0.6, custom_url: 'bad' } };
    await sendPromptRequest(args);
    assert.deepEqual(calls[0], ['profile', history, 800, { stream: false, signal, extractData: true, includePreset: true, includeInstruct: false }, { temperature: 0.6 }]);
    await sendPromptRequest({ ...args, settings: { ...settings, promptConnectionMode: 'manual' } });
    assert.deepEqual(manual[0].slice(1), [history, 800, signal, { temperature: 0.6 }]);
    await sendPromptRequest({ ...args, preset: null });
    assert.deepEqual(calls[1], ['profile', history, 800, { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true }]);
    context.extensionSettings.connectionManager.profiles[0].api = 'tc';
    await assert.rejects(sendPromptRequest(args), /Text Completion/);
    await sendPromptRequest({ ...args, preset: null }); // Old text-completion still works.
    assert.equal(calls.length, 3);
});
