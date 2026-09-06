import assert from 'node:assert/strict';
import { test } from 'node:test';
import { INLINE_KEY, buildSceneTargets, scenePlanInstruction, parseScenePlan, inlineSlots, markerFor, stripSceneMarkers, syncInlineSwipe, safeInlineImage, migrateInlineMedia, hasStaleInlineGallery } from '../inline-scenes.js';
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

test('numbered targets preserve repeated paragraphs, Markdown punctuation and CRLF bytes', () => {
    const cleaned = '**她走進樹林。**\r\n\r\n她停下。\r\n\r\n她停下。';
    const source = '<think>not sent</think>\r\n' + cleaned + '  \r\n';
    const targets = buildSceneTargets(cleaned, source);
    assert.equal(targets.length, 3);
    const raw = JSON.stringify({ scenes: [
        { after_id: 'p3', label: '停下', prompt: 'standing' },
        { after_id: 'p1', label: '林間', prompt: 'forest' },
    ] });
    const result = parseScenePlan(raw, cleaned, source, 3);
    assert.deepEqual(result.slots.map(slot => slot.label), ['林間', '停下']);
    assert.equal(result.mes.replace(/\n\n\[\[cmi-image:[\w-]+\]\]\n\n/g, ''), source);
    assert.ok(result.mes.indexOf(markerFor(result.slots[0].id)) < result.mes.indexOf('她停下。'));
    assert.ok(result.mes.indexOf(markerFor(result.slots[1].id)) > result.mes.lastIndexOf('她停下。'));
    const instruction = scenePlanInstruction(cleaned, 3, targets);
    assert.match(instruction, /after_id/); assert.doesNotMatch(instruction, /not sent|"end":/);
});

test('target discovery excludes unmappable text, ambiguous matches and fenced code before requesting', () => {
    const source = 'header\nA.\nremoved\nB.\nfooter';
    assert.deepEqual(buildSceneTargets('A.\nB.', source).map(t => t.end), [9, 20]);
    assert.deepEqual(buildSceneTargets('rewritten', source), []);
    assert.deepEqual(buildSceneTargets('A.', 'A.\nA.'), []);
    assert.deepEqual(buildSceneTargets('A.', 'A. followed by more prose'), []);
    for (const code of ['```text\nA.\n```', '~~~\nA.\n~~~']) {
        assert.deepEqual(buildSceneTargets(code, code), []);
    }
    assert.throws(() => scenePlanInstruction('rewritten', 3, []), /未送出 LLM/);
});

test('targets exclude HTML attributes/comments/raw text and Markdown code contexts', () => {
    for (const hidden of [
        '<div title="\nhidden\n">\n</div>', '<!--\nhidden\n-->',
        '<textarea>\nhidden\n</textarea>', '<pre>\nhidden\n</pre>',
        '    hidden', '> ```js\n> hidden\n> ```',
        '```js\n```not-a-closing-fence\nhidden\n```',
    ]) {
        const source = hidden + '\nVisible.';
        assert.deepEqual(buildSceneTargets(source, source).map(t => t.text), ['Visible.'], hidden);
        assert.throws(() => plan([{ ...scenes[0], after: 'hidden' }], source, source));
    }
    const wrapped = '<story>\nVisible.\n</story>';
    assert.deepEqual(buildSceneTargets(wrapped, wrapped).map(t => t.text), ['Visible.']);
});

test('fallback mapping rejects cleaned collisions, reordered source and oversized scans', () => {
    const source = 'A red fox.\nA blue fox.\nTail.';
    assert.deepEqual(buildSceneTargets(source.replace('red', 'blue'), source).map(t => t.text), ['Tail.']);
    assert.deepEqual(buildSceneTargets('Tail.\nA red fox.', source), []);
    assert.throws(() => buildSceneTargets('x'.repeat(100001), 'x'.repeat(100001)), /正文過長/);
    assert.throws(() => buildSceneTargets('x\n'.repeat(2001), ''), /2000 行|正文過長/);
});

test('numbered plans reject fabricated, conflicting and duplicate IDs without guessing', () => {
    for (const scene of [
        { after_id: 'p99' }, { after_id: 1 }, { after_id: '__proto__' },
        { after_id: 'p1', after: body }, { after_id: null, after: body },
    ]) assert.throws(() => plan([{ label: 'scene', prompt: 'forest', ...scene }]), /編號/);
    const scene = { after_id: 'p1', label: 'scene', prompt: 'forest' };
    assert.throws(() => plan([scene, scene]), /重複/);
});

test('planner protocol cleanup handles leading reasoning only, not JSON string contents', () => {
    const json = JSON.stringify({ scenes: [{ after_id: 'p1', label: 'scene', prompt: 'sign reading <think>literal</think>' }] });
    const result = parseScenePlan('<thinking>reasoning</thinking>\n```json\n' + json + '\n```', body, body, 3);
    assert.equal(result.slots[0].prompt, 'sign reading <think>literal</think>');
    assert.throws(() => parseScenePlan(' ', body, body, 3), /回傳空白/);
    assert.throws(() => parseScenePlan('<think>unfinished\n' + json, body, body, 3), /有效的插圖 JSON/);
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

test('legacy tagged gallery entries move into scene history without losing metadata or other attachments', () => {
    const result = plan();
    const old = { url: '/user/images/old.png', cmi_scene_id: 'scene-1', seed: '0', title: 'old prompt' };
    const current = { url: '/user/images/current.png', cmi_scene_id: 'scene-1', seed: '1' };
    const unrelated = { url: '/user/images/attachment.png', title: 'Keep me' };
    const unknown = { url: '/user/images/unknown.png', cmi_scene_id: 'not-our-slot' };
    result.slots[0].images = [current.url];
    const message = { mes: result.mes, swipe_id: 0, swipes: [result.mes, 'other'], swipe_info: [{}, { extra: { untouched: true } }],
        extra: { [INLINE_KEY]: { version: 1, slots: result.slots }, media: [old, current, unrelated, unknown], media_index: 2, media_display: 'gallery', inline_image: true } };
    assert.equal(migrateInlineMedia(message), true);
    assert.deepEqual(message.extra.media, [unrelated, unknown]);
    assert.equal(message.extra.media_index, 0);
    assert.deepEqual(result.slots[0].media, [old, current]);
    assert.deepEqual(result.slots[0].images, [current.url]);
    assert.deepEqual(message.swipe_info[0].extra, message.extra);
    assert.deepEqual(message.swipe_info[1].extra, { untouched: true });
    assert.equal(migrateInlineMedia(message), false, 'Migration is idempotent');
    assert.equal(result.slots[0].media.length, 2);
});

test('legacy cleanup handles a duplicate-only gallery but does not guess ownership from URLs', () => {
    const result = plan();
    const image = { url: '/user/images/test.png', cmi_scene_id: 'scene-1' };
    const message = { mes: result.mes, extra: { [INLINE_KEY]: { version: 1, slots: result.slots }, media: [image], media_index: 0 } };
    assert.equal(migrateInlineMedia(message), false, 'Incomplete plans must not lose their only visible image');
    result.slots[0].images = [image.url];
    assert.equal(migrateInlineMedia(message), true);
    assert.deepEqual(message.extra.media, []);
    assert.equal(message.extra.media_index, undefined);
    message.extra.media = [{ url: image.url }];
    assert.equal(migrateInlineMedia(message), false);
    message.extra.media = [image]; message.mes = 'marker removed';
    assert.equal(migrateInlineMedia(message), false, 'Removed markers keep their legacy attachments');
    message.mes = result.mes; message.extra.media = [{ ...image, url: 'https://untrusted.invalid/test.png' }];
    assert.equal(migrateInlineMedia(message), false);
});

test('late legacy gallery writes are detected without removing current or unrelated attachments', () => {
    const result = plan();
    const url = '/user/images/legacy.png', other = '/user/images/unrelated.png';
    result.slots[0].media = [{ url, cmi_scene_id: 'scene-1' }];
    const message = { mes: result.mes, extra: { [INLINE_KEY]: { version: 1, slots: result.slots }, media: [] } };
    const root = paths => ({ querySelectorAll: selector => {
        assert.equal(selector, '.mes_media_wrapper img');
        return paths.map(path => ({ getAttribute: () => path }));
    } });
    assert.equal(hasStaleInlineGallery(root([url]), message), true);
    assert.equal(hasStaleInlineGallery(root([other]), message), false);
    assert.equal(hasStaleInlineGallery(root([]), message), false);
    message.extra.media = [{ url }];
    assert.equal(hasStaleInlineGallery(root([url]), message), false, 'Explicit current attachment wins over archived URLs');
    message.extra.media = []; message.mes = 'different swipe';
    assert.equal(hasStaleInlineGallery(root([url]), message), false);
    assert.equal(hasStaleInlineGallery(null, message), false);
});

test('inline images reject remote, data, relative and backslash URLs', () => {
    for (const path of ['https://evil.invalid/a.png', '//evil.invalid/a.png', '/\\evil.invalid/a.png', 'data:image/png,a', 'javascript:alert(1)', 'relative.png', '/a\nb']) assert.equal(safeInlineImage(path), false, path);
    assert.equal(safeInlineImage('/user/images/artist/image.png'), true);
    assert.equal(safeInlineImage('/user/images/Alice Smith/Alice Smith_image.png'), true);
    for (const path of ['/proxy/https://evil.invalid/a.png', '/api/anything.png', '/user/images/../other.png', '/user/images/%2e%2e/other.png', '/user/images/a%2f..%2f..%2fother.png', '/user/images/%5c.png', '/user/images/a.png?url=evil']) assert.equal(safeInlineImage(path), false, path);
});
