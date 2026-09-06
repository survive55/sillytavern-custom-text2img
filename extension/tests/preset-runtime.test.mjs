import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeLlmPreset } from '../llm-presets.js';
import { createPresetMacros } from '../preset-macros.js';
import { applyPresetRegex } from '../preset-regex.js';
import { createPresetState, preparePresetRequest, acceptPresetResponse } from '../preset-runtime.js';
import { cleanScene, cleanSceneText, snapshotScene, parseBodyCleanupRules, DEFAULT_BODY_CLEANUP } from '../scene-text.js';
const rule = (extra = {}) => ({ id: 'test', scriptName: 'Test', findRegex: '/old/g', replaceString: 'new', trimStrings: [], placement: [1, 2],
    disabled: false, markdownOnly: false, promptOnly: true, runOnEdit: false, substituteRegex: 0, minDepth: null, maxDepth: null, ...extra });
const raw = (rules = [], extra = {}) => ({ prompts: [
    { identifier: 'main', role: 'system', content: '{{setvar::tone::calm}}{{getvar::tone}} {{user}} {{lastCharMessage}}' },
    { identifier: 'chatHistory', marker: true },
], prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: true }] }],
    extensions: { regex_scripts: rules }, ...extra });
const snapshot = () => snapshotScene([{ name: 'User', is_user: true, mes: 'old <thinking>hidden user</thinking>' },
    { name: 'Char', mes: '<Interleaving><thinking>hidden first</thinking>old scene<thinking>hidden later</thinking></Interleaving>' },
    { name: 'Char', mes: 'future' }], 1, 4);
const state = (rules = [], extra = {}) => createPresetState({ preset: normalizeLlmPreset(raw(rules, extra)).preset, snapshot: snapshot(),
    fields: { description: 'traveler' }, char: 'Char', user: 'User', bodyCleanupRules: DEFAULT_BODY_CLEANUP });

test('imports native rules only, preserves flags and order across reloads, never mutates source', () => {
    const input = raw([rule(), rule({ disabled: true }), rule({ markdownOnly: true, promptOnly: false })]);
    input.extensions.SPreset = { RegexBinding: { regexes: [rule({ replaceString: 'WRONG COPY' })] } };
    input.extensions.tavern_helper = { scripts: [{ content: 'NEVER EXECUTE' }] };
    const before = structuredClone(input), imported = normalizeLlmPreset(input);
    assert.deepEqual(imported.preset.extensions.regex_scripts, input.extensions.regex_scripts);
    assert.deepEqual(normalizeLlmPreset(imported.preset).preset, imported.preset);
    assert.ok(imported.warnings.some(text => text.includes('SPreset')));
    assert.doesNotMatch(JSON.stringify(imported.preset), /WRONG COPY|NEVER EXECUTE/);
    assert.deepEqual(input, before);
    assert.throws(() => normalizeLlmPreset(raw([rule({ findRegex: '/[/g' })])), /語法/);
    assert.throws(() => normalizeLlmPreset(raw([rule({ disabled: 'false' })])), /布林/);
});

test('regex stage/role/depth and disabled flags, groups, trim, global flags and literal patterns', () => {
    assert.equal(applyPresetRegex('old old', [rule()], { role: 'user', stage: 'prompt' }), 'new new');
    for (const extra of [{ role: 'system', stage: 'prompt' }, { role: 'assistant', stage: 'display' }, { role: 'user', stage: 'raw' }]) {
        assert.equal(applyPresetRegex('old', [rule()], extra), 'old');
    }
    for (const config of [{ disabled: true }, { placement: [2] }, { minDepth: 1 }, { maxDepth: 1 }]) {
        assert.equal(applyPresetRegex('old', [rule(config)], { role: 'user', stage: 'prompt', depth: config.maxDepth ? 2 : 0 }), 'old');
    }
    assert.equal(applyPresetRegex('old', [rule({ markdownOnly: true })], { role: 'assistant', stage: 'display' }), 'new');
    const captures = rule({ findRegex: '(?<name>hello)', replaceString: '{{match}}|$1|$<name>|$99', trimStrings: ['ll'] });
    assert.equal(applyPresetRegex('hello', [captures], { role: 'user', stage: 'prompt' }), 'heo|heo|heo|');
    const macros = createPresetMacros({ values: { user: 'A+B' } });
    assert.equal(applyPresetRegex('A+B', [rule({ findRegex: '{{user}}', substituteRegex: 2 })], { role: 'user', stage: 'prompt', expand: macros.expand }), 'new');
    assert.equal(applyPresetRegex('{{setvar::leak::yes}}', [rule({ findRegex: '(.*)', replaceString: '$1' })], { role: 'user', stage: 'prompt', expand: macros.expand }), '{{setvar::leak::yes}}');
    assert.equal(macros.expand('{{getvar::leak}}'), '');
});

test('isolated macro variables, comments, nested values, opaque scene values, independent global namespace', () => {
    const m = createPresetMacros({ values: { message: '{{setvar::escaped::bad}}', char: 'Traveler' }, random: () => 0 });
    assert.equal(m.expand('{{setvar::a::{{char}}}}{{getvar::a}}'), 'Traveler');
    assert.equal(m.expand('{{// {{setvar::a::bad}} }}{{getvar::a}}').endsWith('Traveler'), true);
    assert.equal(m.expand('{{setglobalvar::a::private}}{{getglobalvar::a}}/{{getvar::a}}'), 'private/Traveler');
    assert.equal(m.expand('{{setvar::n::2}}{{addvar::n::3}}{{incvar::n}}/{{decvar::n}}'), '6/5');
    assert.equal(m.expand('{{message}}'), '{{setvar::escaped::bad}}');
    assert.equal(m.expand('{{getvar::escaped}}'), '');
    assert.equal(createPresetMacros().expand('{{getvar::a}}'), '');
    assert.equal(m.expand('{{random::one::two}}/{{roll:1d6}}'), 'one/1');
    assert.equal(m.expand('{{thirdPartyAction}}'), '{{thirdPartyAction}}');
    assert.ok([...m.warnings].some(value => value.includes('thirdpartyaction')));
});

test('editable scene cleanup handles interleaved thoughts, no markers, unclosed thoughts, case, custom wrappers and no macro execution', () => {
    const defaults = parseBodyCleanupRules(DEFAULT_BODY_CLEANUP);
    assert.equal(cleanSceneText('A<thinking>kept by default</thinking>B', parseBodyCleanupRules()), 'A<thinking>kept by default</thinking>B');
    assert.equal(cleanSceneText('A<thinking>one</thinking>B<THINKING>two</THINKING>C<think>three</think>D', defaults), 'ABCD');
    assert.equal(cleanSceneText('A<thinking>unfinished', defaults), 'A');
    assert.equal(cleanSceneText('plain story', defaults), 'plain story');
    assert.equal(cleanSceneText('{{setvar::x::1}}', defaults), '{{setvar::x::1}}');
    const custom = parseBodyCleanupRules(JSON.stringify([{ findRegex: '/^[\\s\\S]*?<story>([\\s\\S]*?)<\\/story>[\\s\\S]*$/', replaceString: '$1' }]));
    assert.equal(cleanSceneText('header<story>body</story>summary', custom), 'body');
    assert.throws(() => parseBodyCleanupRules('bad'), /不會退回/);
    assert.throws(() => parseBodyCleanupRules('[{"findRegex":"[","replaceString":""}]'), /語法/);
});

test('all floor references use cleaned text, no future or reasoning field, source unchanged', () => {
    const input = snapshot(), before = structuredClone(input), scene = cleanScene(input, DEFAULT_BODY_CLEANUP);
    assert.doesNotMatch(JSON.stringify(scene), /hidden|future/);
    assert.match(scene.values.message, /old scene/);
    assert.equal(scene.values.lastUserMessage, '');
    assert.equal(scene.history.length, 1, 'Main-chat user messages are not scene data');
    assert.equal(scene.values.lastCharMessage, scene.values.message);
    assert.deepEqual(input, before);
    assert.throws(() => cleanScene({ ...input, target: { ...input.target, text: '<thinking>only thought</thinking>' } }, DEFAULT_BODY_CLEANUP), /沒有正文/);
});

test('request/response runtime keeps state transactional, cleans all aliases, regex changes prompt but display HTML never enters history', () => {
    const rules = [rule(), rule({ findRegex: '(options)', replaceString: '<html><script>displayOnly()</script>$1</html>', markdownOnly: true, promptOnly: false })];
    const initial = state(rules), before = structuredClone(initial);
    const prepared = preparePresetRequest(initial);
    assert.deepEqual(initial, before);
    assert.doesNotMatch(JSON.stringify(prepared.messages), /hidden|future|old/);
    assert.match(JSON.stringify(prepared.messages), /calm User/);
    const received = acceptPresetResponse(prepared.state, '<thinking>secret</thinking>old options');
    assert.match(received.display, /displayOnly/);
    assert.equal(received.prompt, 'new options');
    assert.doesNotMatch(JSON.stringify(received.state.turns), /displayOnly|secret/);
    const next = preparePresetRequest(received.state, 'next<thinking>not sent</thinking>');
    assert.deepEqual(next.messages.slice(-2), [{ role: 'assistant', content: 'new options' }, { role: 'user', content: 'next' }]);
    assert.equal(received.state.turns.length, 1, 'Failed LLM send can discard draft without accumulating user turns');
    assert.equal(preparePresetRequest(state()).state.macroState.variables.find(([key]) => key === 'tone')[1], 'calm');
});

test('history marker stays off for ST scene but explicit independent follow-up is delivered', () => {
    const initial = state([], { prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true }, { identifier: 'chatHistory', enabled: false }] }] });
    const first = preparePresetRequest(initial);
    assert.equal(first.messages.length, 1);
    const response = acceptPresetResponse(first.state, 'landscape');
    const second = preparePresetRequest(response.state, 'use sunset');
    assert.deepEqual(second.messages.slice(-2), [{ role: 'assistant', content: 'landscape' }, { role: 'user', content: 'use sunset' }]);
});
