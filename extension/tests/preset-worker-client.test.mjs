import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runPresetTask } from '../preset-worker-client.js';

function mockWorkers(t) {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'Worker');
    const workers = [];
    class FakeWorker {
        constructor(url, options) { this.url = url; this.options = options; this.terminations = 0; workers.push(this); }
        postMessage(data) { this.request = data; }
        terminate() { this.terminations++; }
    }
    Object.defineProperty(globalThis, 'Worker', { configurable: true, writable: true, value: FakeWorker });
    t.after(() => { if (original) Object.defineProperty(globalThis, 'Worker', original); else delete globalThis.Worker; });
    return workers;
}

function assertDisposed(worker) {
    assert.equal(worker.terminations, 1);
    assert.equal(worker.onmessage, null);
    assert.equal(worker.onerror, null);
    assert.equal(worker.onmessageerror, null);
}

test('preset processing can exceed four seconds without timing out, then disposes on success', async t => {
    const workers = mockWorkers(t);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const controller = new AbortController();
    let settled = false;
    const task = runPresetTask('prepare', { state: {} }, controller.signal);
    task.then(() => { settled = true; }, () => { settled = true; });
    t.mock.timers.tick(60_000);
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(workers[0].terminations, 0);
    assert.deepEqual(workers[0].request, { type: 'prepare', payload: { state: {} } });
    assert.equal(workers[0].options.type, 'module');
    workers[0].onmessage({ data: { ok: true, result: { messages: ['ready'] } } });
    assert.deepEqual(await task, { messages: ['ready'] });
    controller.abort();
    assertDisposed(workers[0]);
});

test('manual cancellation terminates pending work once and ignores queued replies', async t => {
    const workers = mockWorkers(t), controller = new AbortController();
    const remove = t.mock.method(controller.signal, 'removeEventListener');
    const task = runPresetTask('clean', {}, controller.signal);
    const rejected = assert.rejects(task, error => error.name === 'AbortError' && /已取消/.test(error.message));
    const queuedReply = workers[0].onmessage;
    controller.abort();
    queuedReply({ data: { ok: true, result: 'too late' } });
    await rejected;
    assertDisposed(workers[0]);
    assert.equal(remove.mock.callCount(), 1);
    assert.equal(remove.mock.calls[0].arguments[0], 'abort');
});

test('already cancelled tasks do not start a Worker', t => {
    const workers = mockWorkers(t), controller = new AbortController();
    controller.abort();
    assert.throws(() => runPresetTask('clean', {}, controller.signal), { name: 'AbortError' });
    assert.equal(workers.length, 0);
});

test('worker exceptions preserve operation, message, type and remote stack; legacy strings still work', async t => {
    const workers = mockWorkers(t);
    const task = runPresetTask('accept', {});
    workers[0].onmessage({ data: { ok: false, error: { name: 'SyntaxError', message: 'invalid rule', stack: 'SyntaxError: invalid rule\n at preset-regex.js:58:9' } } });
    await assert.rejects(task, error => error.name === 'SyntaxError' && /accept.*invalid rule/.test(error.message) && /preset-regex.js:58/.test(error.stack));
    assertDisposed(workers[0]);
    const legacy = runPresetTask('create', {});
    workers[1].onmessage({ data: { ok: false, error: 'legacy failure' } });
    await assert.rejects(legacy, /create.*legacy failure/);
    assertDisposed(workers[1]);
});

test('browser Worker errors include the browser reason and source location', async t => {
    const workers = mockWorkers(t), task = runPresetTask('create', {});
    workers[0].onerror({ message: 'Cannot load module', filename: 'http://localhost/preset-runtime.js', lineno: 10, colno: 2 });
    await assert.rejects(task, /create.*Cannot load module.*preset-runtime.js:10:2/);
    assertDisposed(workers[0]);
});

test('unreadable or malformed replies reject rather than wait indefinitely', async t => {
    const workers = mockWorkers(t);
    const unreadable = runPresetTask('prepare', {});
    workers[0].onmessageerror({});
    await assert.rejects(unreadable, /prepare.*無法讀取/);
    assertDisposed(workers[0]);
    const malformed = runPresetTask('clean', {});
    workers[1].onmessage({ data: null });
    await assert.rejects(malformed, /clean.*未回傳有效結果/);
    assertDisposed(workers[1]);
});

test('postMessage failures terminate the Worker and remove cancellation listeners', async t => {
    const workers = mockWorkers(t), controller = new AbortController();
    t.mock.method(globalThis.Worker.prototype, 'postMessage', () => { throw new DOMException('uncloneable payload', 'DataCloneError'); });
    await assert.rejects(runPresetTask('prepare', {}, controller.signal), { name: 'DataCloneError' });
    controller.abort();
    assertDisposed(workers[0]);
});
