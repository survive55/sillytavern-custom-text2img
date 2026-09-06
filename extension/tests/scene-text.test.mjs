import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanScene, snapshotScene } from '../scene-text.js';

const chat = () => [
    { name: 'Alice', mes: 'earlier assistant' },
    { name: 'User', is_user: true, mes: 'EXCLUDED ST USER' },
    { name: 'User', role: 'user', mes: 'EXCLUDED ROLE USER' },
    { name: 'User', role: 'user', is_user: false, mes: 'EXCLUDED CONFLICTING USER' },
    { is_system: true, mes: 'EXCLUDED ST SYSTEM' },
    { role: 'system', mes: 'EXCLUDED ROLE SYSTEM' },
    { extra: { type: 'narrator' }, mes: 'EXCLUDED NARRATOR' },
    { name: 'Bob', role: 'assistant', is_user: false, mes: 'recent assistant' },
    { is_user: true, mes: 'EXCLUDED LATEST USER' },
    { name: 'Alice', role: 'assistant', mes: 'target assistant', extra: { reasoning: 'EXCLUDED REASONING' } },
    { role: 'assistant', mes: 'EXCLUDED FUTURE' },
];

test('scene snapshots and all aliases contain only assistant bodies, counting assistant history', () => {
    const input = chat(), before = structuredClone(input);
    for (const [depth, ids] of [[0, [9]], [1, [7, 9]], [2, [0, 7, 9]], [50, [0, 7, 9]]]) {
        const snapshot = snapshotScene(input, 9, depth);
        assert.deepEqual(snapshot.history.map(message => message.id), ids);
        assert.ok(snapshot.history.every(message => message.role === 'assistant'));
        assert.equal(snapshot.lastUser, null);
        assert.doesNotMatch(JSON.stringify(snapshot), /EXCLUDED/);
        const scene = cleanScene(snapshot, '[]');
        for (const key of ['message', 'lastMessage', 'lastChatMessage', 'lastCharMessage']) {
            assert.equal(scene.values[key], 'target assistant');
        }
        assert.equal(scene.values.lastMessageId, '9');
        assert.equal(scene.values.lastUserMessage, '');
        assert.doesNotMatch(JSON.stringify(scene), /EXCLUDED/);
    }
    assert.equal(cleanScene(snapshotScene(input, 9, 2), '[]').values.history, 'Alice: earlier assistant\n\nBob: recent assistant');
    assert.deepEqual(input, before);
});

test('non-assistant or empty targets are rejected instead of falling back to earlier content', () => {
    const targets = [
        { is_user: true }, { is_system: true }, { extra: { type: 'narrator' } },
        ...['user', 'system', 'tool', 'function', 'developer', 'model', ''].map(role => ({ role })),
        { role: 'assistant', is_user: true }, { role: 'assistant', is_system: true }, { mes: ' ' },
    ];
    for (const target of targets) {
        assert.throws(() => snapshotScene([{ mes: 'earlier assistant' }, { mes: 'EXCLUDED TARGET', ...target }], 1, 50), /目標樓層/);
    }
});

test('cleaning a legacy snapshot cannot reintroduce user history or lastUserMessage', () => {
    const snapshot = snapshotScene(chat(), 9, 1);
    const user = { id: 8, role: 'user', name: 'User', text: 'EXCLUDED LEGACY USER' };
    snapshot.history.splice(1, 0, user);
    snapshot.lastUser = user;
    const before = structuredClone(snapshot);
    const scene = cleanScene(snapshot, '[]');
    assert.doesNotMatch(JSON.stringify(scene), /EXCLUDED/);
    assert.equal(scene.values.lastUserMessage, '');
    assert.deepEqual(scene.history.map(message => message.id), [7, 9]);
    assert.deepEqual(snapshot, before);
    assert.throws(() => cleanScene({ ...snapshot, target: user }, '[]'), /沒有正文/);
});
