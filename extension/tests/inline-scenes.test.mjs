import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INLINE_KEY, scenePlanInstruction, parseScenePlan, inlineSlots, markerFor, stripSceneMarkers, syncInlineSwipe, safeInlineImage } from '../inline-scenes.js';
import { snapshotScene } from '../scene-text.js';
const body = '她走進樹林。\n\n晚霞照亮湖面。';
const scenes = [
    { after: '她走進樹林。', label: '林間', prompt: '1girl, forest, walking' },
    { after: '晚霞照亮湖面。', label: '湖畔', prompt: 'lake, sunset' },
];
const plan = (value = scenes, source = body, cleaned = body) => {
    let id = 0;
    return parseScenePlan(JSON.stringify({ scenes: value }), cleaned, source, 3, () => `scene-${++id}`);
};

test('plan inserts multiple data-only markers in story order without rewriting a byte of the body', () => {
    const result = plan([...scenes].reverse());
    assert.deepEqual(result.slots.map(slot => slot.label), ['林間', '湖畔']);
    assert.equal(result.mes.replace(/\n\n\[\[cmi-image:[\w-]+\]\]\n\n/g, ''), body);
    assert.deepEqual(result.slots[0].images, []);
    assert.match(scenePlanInstruction(body, 99), /1 to 6/);
    assert.match(scenePlanInstruction(body, 3), /TARGET BODY/);
});

test('JSON fences are tolerated, but prose, empty, too many and incomplete plans never mutate input', () => {
    assert.equal(parseScenePlan('```json\n' + JSON.stringify({ scenes }) + '\n```', body, body, 3).slots.length, 2);
    for (const raw of ['not JSON', '{}', '{"scenes":[]}', '{"scenes":[{}]}', 'x'.repeat(100001)]) {
        assert.throws(() => parseScenePlan(raw, body, body, 3));
    }
    assert.throws(() => parseScenePlan(JSON.stringify({ scenes }), body, body, 1));
    assert.throws(() => plan([{ ...scenes[0], prompt: '' }]));
    assert.throws(() => plan([{ ...scenes[0], label: 'a'.repeat(101) }]));
    assert.throws(() => plan([scenes[0], scenes[0]]), /重複/);
});

test('anchors must uniquely match both cleaned body and source at a safe line boundary', () => {
    assert.throws(() => plan([{ ...scenes[0], after: '不存在' }]), /唯一/);
    assert.throws(() => plan([scenes[0]], body + '\n' + scenes[0].after), /唯一/);
    assert.throws(() => plan([{ ...scenes[0], after: '她走' }]), /行尾/);
    assert.throws(() => plan([scenes[0]], '原始內容不相同'), /唯一/);
    const code = '```text\n她走進樹林。\n```';
    assert.throws(() => plan([scenes[0]], code, code), /程式碼/);
    const withReasoning = '<think>unused</think>\n' + body;
    assert.ok(plan(scenes, withReasoning).mes.startsWith('<think>unused</think>\n'));
});

test('unknown, removed and foreign-swipe markers cannot become active slots', () => {
    const result = plan(), message = { mes: result.mes, extra: { [INLINE_KEY]: { version: 1, slots: result.slots } } };
    assert.equal(inlineSlots(message).length, 2);
    message.mes = message.mes.replace(markerFor(result.slots[0].id), '');
    assert.equal(inlineSlots(message).length, 1);
    message.mes = 'different swipe'; assert.equal(inlineSlots(message).length, 0);
    message.extra[INLINE_KEY].version = 42; assert.equal(inlineSlots(message).length, 0);
    assert.equal(stripSceneMarkers('a[[cmi-image:123]]b'), 'ab');
    assert.equal(snapshotScene([{ mes: 'a[[cmi-image:123]]b' }], 0, 0).target.text, 'ab');
});

test('only current swipe receives the modified text and a detached metadata copy', () => {
    const result = plan();
    const message = { mes: result.mes, swipe_id: 1, swipes: ['other', body], swipe_info: [{ extra: { untouched: true } }, { send_date: 'date' }],
        extra: { [INLINE_KEY]: { version: 1, slots: result.slots }, media: [{ url: '/user/images/test.png' }] } };
    syncInlineSwipe(message);
    assert.equal(message.swipes[0], 'other'); assert.deepEqual(message.swipe_info[0], { extra: { untouched: true } });
    assert.equal(message.swipes[1], result.mes); assert.equal(message.swipe_info[1].send_date, 'date');
    assert.deepEqual(message.swipe_info[1].extra, message.extra);
    assert.notEqual(message.swipe_info[1].extra, message.extra);
});

test('inline images reject remote, data, relative and backslash URLs', () => {
    for (const path of ['https://evil.invalid/a.png', '//evil.invalid/a.png', '/\\evil.invalid/a.png', 'data:image/png,a', 'javascript:alert(1)', 'relative.png', '/a\nb']) assert.equal(safeInlineImage(path), false, path);
    assert.equal(safeInlineImage('/user/images/artist/image.png'), true);
    assert.equal(safeInlineImage('/user/images/Alice Smith/Alice Smith_image.png'), true);
    for (const path of ['/proxy/https://evil.invalid/a.png', '/api/anything.png', '/user/images/../other.png', '/user/images/%2e%2e/other.png', '/user/images/a%2f..%2f..%2fother.png', '/user/images/%5c.png', '/user/images/a.png?url=evil']) assert.equal(safeInlineImage(path), false, path);
});
