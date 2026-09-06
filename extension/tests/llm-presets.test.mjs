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

test('selected order alone controls activation, then quiet triggers filter before expansion', () => {
    for (const promptEnabled of [true, false, undefined]) {
        for (const orderEnabled of [true, false, undefined]) {
            for (const triggers of [undefined, [], ['normal'], ['quiet'], ['normal', 'quiet']]) {
                const raw = fixture([p('candidate', 'Candidate', { enabled: promptEnabled, injection_trigger: triggers }), p('chatHistory')],
                    [{ identifier: 'candidate', enabled: orderEnabled }, o('chatHistory')]);
                const before = structuredClone(raw);
                const { preset } = importLlmPreset(JSON.stringify(raw));
                const active = orderEnabled === true && (!triggers?.length || triggers.includes('quiet'));
                const expected = active ? [{ role: 'system', content: 'Candidate' }, ...history] : history;
                const expanded = [];
                assert.deepEqual(buildPresetMessages(preset, { history, expand: text => { expanded.push(text); return text; } }), expected);
                assert.deepEqual(expanded, active ? ['Candidate'] : []);
                assert.equal(getPresetOrder(preset)[0].enabled, orderEnabled === true);
                assert.equal(preset.prompts[0].enabled, promptEnabled, 'Retain metadata without using it as a veto');
                assert.equal(Object.hasOwn(preset.prompts[0], 'enabled'), promptEnabled !== undefined);
                assert.equal(preset.prompt_order[0].order[0].enabled, orderEnabled === true);
                const reloaded = normalizeLlmPreset(JSON.parse(JSON.stringify(preset))).preset;
                assert.deepEqual(reloaded, preset);
                assert.deepEqual(buildPresetMessages(reloaded, { history }), expected);
                assert.deepEqual(raw, before);
            }
        }
    }
});

test('disabled and unlisted prompts are never expanded, irrespective of storage order', () => {
    const raw = fixture([p('phi', 'Tags only'), p('off', 'ORDER OFF', { enabled: true }),
        p('unlisted', 'UNLISTED', { enabled: true }), p('main', 'ORDER OFF', { enabled: false }),
        p('chatHistory', 'must not be sent', { marker: true })],
    [o('main', false), o('off', false), o('chatHistory'), o('phi')]);
    const expanded = [];
    assert.deepEqual(build(raw, { expand: text => { expanded.push(text); return text; } }),
        [...history, { role: 'system', content: 'Tags only' }]);
    assert.deepEqual(expanded, ['Tags only']);
});

test('imports preserve model and unknown roles without activating unused prompts or changing the source', () => {
    const raw = fixture([
        p('off', 'Do not send', { role: 'unknown' }),
        p('empty', '', { role: 'model' }),
        // Regression: a valid full preset can retain model-role prompts outside every order.
        ...Array.from({ length: 4 }, (_, i) => p(`unlisted-${i}`, 'Not in order', { role: 'model' })),
        p('quiet-off', 'Not for quiet', { role: 'tool', injection_trigger: ['normal'] }),
        p('prefill', 'A quiet landscape', { role: 'model', enabled: true }),
        p('main', 'Describe the scene', { role: 'user' }),
        p('chatHistory', '', { marker: true }),
    ], [o('main'), o('off', false), o('chatHistory'), o('empty'), o('quiet-off'), o('prefill')]);
    raw.prompt_order.unshift({ character_id: 100000, order: [o('off')] });
    const before = structuredClone(raw);
    const imports = [normalizeLlmPreset(raw), importLlmPreset(JSON.stringify(raw), 'model-role.json')];
    for (const type of ['full', 'character']) {
        imports.push(importLlmPreset(JSON.stringify({ version: 1, type,
            data: { prompts: raw.prompts, prompt_order: raw.prompt_order[1].order } })));
    }
    for (const { preset, orderId } of imports) {
        assert.equal(orderId, '100001');
        for (const original of raw.prompts) {
            const normalized = preset.prompts.find(item => item.identifier === original.identifier);
            assert.equal(normalized.role, original.role);
            assert.equal(normalized.content, original.content);
        }
        assert.deepEqual(getPresetOrder(preset, orderId), raw.prompt_order[1].order);
        const expanded = [];
        assert.deepEqual(buildPresetMessages(preset, { history, expand: text => { expanded.push(text); return text; } }), [
            { role: 'user', content: 'Describe the scene' }, ...history,
            { role: 'model', content: 'A quiet landscape' },
        ]);
        assert.ok(!expanded.some(text => ['Do not send', 'Not in order', 'Not for quiet'].includes(text)));
        assert.deepEqual(normalizeLlmPreset(JSON.parse(JSON.stringify(preset))).preset, preset, 'Reload preserves roles');
        assert.deepEqual(preset.prompts.map(item => item.role), raw.prompts.map(item => item.role), 'Building must not rewrite saved roles');
    }
    assert.deepEqual(raw, before);
});

test('Relative follows ST Message: preserve truthy roles and default falsy roles only when building', () => {
    for (const role of ['system', 'user', 'assistant', 'model', 'tool', 'developer', 'unknown', '', 0, false, null, 7, {}, []]) {
        const raw = fixture([p('role', 'Text', { role })]);
        const before = structuredClone(raw);
        const { preset } = importLlmPreset(JSON.stringify(raw));
        assert.deepEqual(preset.prompts[0].role, role);
        assert.deepEqual(buildPresetMessages(preset, { history: [] }), [{ role: role || 'system', content: 'Text' }]);
        assert.deepEqual(normalizeLlmPreset(JSON.parse(JSON.stringify(preset))).preset, preset);
        assert.deepEqual(raw, before);
    }
    const { preset } = importLlmPreset(JSON.stringify(fixture([{ identifier: 'missing-role', content: 'Text' }])));
    assert.equal(Object.hasOwn(preset.prompts[0], 'role'), false, 'Import must not synthesize a role');
    assert.deepEqual(buildPresetMessages(preset, { history: [] }), [{ role: 'system', content: 'Text' }]);
    assert.equal(Object.hasOwn(preset.prompts[0], 'role'), false);
});

test('In-Chat only groups native ST roles; ignored roles cannot shift later injection positions', () => {
    const ignoredRoles = ['model', 'tool', 'developer', 'unknown', undefined, null, '', 0, false, {}, []];
    const raw = fixture([p('chatHistory', '', { marker: true }),
        ...ignoredRoles.map((role, i) => p(`ignored-${i}`, 'IGNORE', { role, injection_position: 1, injection_depth: 5 })),
        p('deep', 'Deep', { role: 'assistant', injection_position: 1, injection_depth: 4 }),
        p('model', 'IGNORE', { role: 'model', injection_position: 1, injection_depth: 1 }),
        p('middle', 'Middle', { role: 'user', injection_position: 1, injection_depth: 1 }),
        p('assistant', 'First', { role: 'assistant', injection_position: 1, injection_depth: 0 }),
        p('assistant-2', 'Second', { role: 'assistant', injection_position: 1, injection_depth: 0 }),
        p('user', 'User', { role: 'user', injection_position: 1, injection_depth: 0 }),
        p('system', 'System', { injection_position: 1, injection_depth: 0 }),
    ]);
    assert.deepEqual(build(raw), [
        { role: 'assistant', content: 'Deep' }, history[0], { role: 'user', content: 'Middle' }, history[1],
        { role: 'assistant', content: 'First\nSecond' }, { role: 'user', content: 'User' }, { role: 'system', content: 'System' },
    ]);
    assert.throws(() => build(fixture([p('chatHistory'), p('only-model', 'Ignored', { role: 'model', injection_position: 1 })]), { history: [] }), /沒有任何/);
});

test('built-in field markers use ST nullish system fallback without changing the stored override', () => {
    for (const role of [undefined, null, '', 'model', 'assistant']) {
        const raw = fixture([p('chatHistory'), p('charDescription', '', { role, injection_position: 1, injection_depth: 0 })]);
        const { preset } = normalizeLlmPreset(raw);
        const messages = buildPresetMessages(preset, { history, fields: { description: 'Traveler' } });
        const expected = role === undefined || role === null ? 'system' : role;
        assert.deepEqual(messages, ['system', 'assistant'].includes(expected)
            ? [...history, { role: expected, content: 'Traveler' }] : history);
        assert.equal(preset.prompts.find(item => item.identifier === 'charDescription').role, role);
    }
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

test('all import formats and order switches use only the selected order, preserving source metadata', () => {
    const prompts = [p('candidate', 'Candidate', { enabled: false }), p('on'), p('chatHistory', '', { enabled: false })];
    const orders = [o('candidate'), o('on'), o('chatHistory')];
    const raw = { prompts, prompt_order: [
        { character_id: 100000, order: [o('candidate', false), o('on'), o('chatHistory', false)] },
        { character_id: 100001, order: orders },
    ] };
    const formats = [raw, ...['full', 'character'].map(type => ({ version: 1, type, data: { prompts, prompt_order: orders } }))];
    for (const format of formats) {
        const { preset } = importLlmPreset(JSON.stringify(format));
        for (const saved of [preset, normalizeLlmPreset(JSON.parse(JSON.stringify(preset))).preset]) {
            for (const { character_id: orderId, order } of [...saved.prompt_order, ...saved.prompt_order].reverse()) {
                assert.deepEqual(getPresetOrder(saved, orderId), order);
                assert.deepEqual(buildPresetMessages(saved, { orderId, history }), orderId === '100000'
                    ? [{ role: 'system', content: 'on' }]
                    : [{ role: 'system', content: 'Candidate' }, { role: 'system', content: 'on' }, ...history]);
            }
            assert.equal(saved.prompts[0].enabled, false);
            assert.equal(saved.prompts[2].enabled, false);
        }
    }
});

test('default order and partial-history fallback ignore stale prompt-level enabled metadata', () => {
    const raw = { prompts: [p('main', 'Main', { enabled: false }), p('jailbreak', 'Tags'),
        p('chatHistory', '', { enabled: false }), p('custom', 'UNLISTED', { enabled: true })] };
    for (const value of [raw, { ...raw, prompt_order: [{ character_id: 100001, order: [o('main'), o('jailbreak')] }] }]) {
        const { preset } = normalizeLlmPreset(value);
        assert.deepEqual(buildPresetMessages(preset, { history }), [
            { role: 'system', content: 'Main' }, ...history, { role: 'system', content: 'Tags' },
        ]);
    }
});

test('large preset regression: all 18 order-on entries stay enabled, not 10 or all 144 prompts', () => {
    // Synthetic metadata only; no private user prompt text is committed.
    const raw = fixture(Array.from({ length: 144 }, (_, index) => p(`p${index}`, `Text ${index}`,
        index >= 10 ? { enabled: false } : {})),
    Array.from({ length: 62 }, (_, index) => o(`p${index}`, index < 18)));
    const { preset } = importLlmPreset(JSON.stringify(raw));
    const order = getPresetOrder(preset);
    assert.equal(order.filter(item => item.enabled).length, 18);
    assert.equal(order.filter(item => !item.enabled).length, 44);
    assert.equal(preset.prompts.length - order.length, 82);
    assert.equal(preset.prompt_order[0].order.filter(item => item.enabled).length, 18, 'Preserve original order switches');
    assert.deepEqual(buildPresetMessages(preset, { history: [] }),
        Array.from({ length: 18 }, (_, index) => ({ role: 'system', content: `Text ${index}` })));
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
    for (const enabled of ['false', 0, null, {}, []]) {
        assert.throws(() => normalizeLlmPreset(fixture([p('a', 'Invalid', { enabled })])), /布林/);
    }
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

test('history selection counts only assistant bodies and rejects a user target', () => {
    const chat = [{ mes: 'earlier assistant' }, { mes: 'EXCLUDED USER', is_user: true },
        { mes: 'EXCLUDED ROLE USER', role: 'user' }, { mes: 'EXCLUDED SYSTEM', is_system: true },
        { mes: 'EXCLUDED NARRATOR', extra: { type: 'narrator' } }, { mes: '' },
        { mes: '{{user}} literal scene', role: 'assistant' }, { mes: 'EXCLUDED FUTURE' }];
    assert.deepEqual(collectPresetHistory(chat, 6, 1), [{ role: 'assistant', content: 'earlier assistant' }, { role: 'assistant', content: '{{user}} literal scene' }]);
    assert.deepEqual(collectPresetHistory(chat, 6, 0), [{ role: 'assistant', content: '{{user}} literal scene' }]);
    assert.throws(() => collectPresetHistory(chat, 2, 50), /目標樓層/);
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
        fixture([p('x', '', { injection_position: 9 })])]) {
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
