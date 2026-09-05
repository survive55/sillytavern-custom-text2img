import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateWithPolling } from '../generation.js';

const JOB = 'a'.repeat(32);
const snapshot = (events = [], cursor = 0, finished = false) => ({
    job_id: JOB, events, next_cursor: cursor, finished,
});
const done = { type: 'done', images: ['1/a.png', '1/b.png'], generation_id: 1, seed: '18446744073709551613' };
const options = () => ({
    signal: new AbortController().signal, onEvent() {},
    delay: async (_ms, signal) => signal.throwIfAborted(),
});

test('incremental polling retries the same cursor, not generation, and restores all images', async () => {
    let submits = 0;
    const reads = [];
    const events = [];
    const responses = [
        snapshot([{ type: 'accepted', generation_id: 1 }, { type: 'image', path: '1/a.png' }], 2),
        Object.assign(new Error('Cloudflare 502'), { status: 502 }),
        { ...snapshot([done], 99, true), events_truncated: true },
    ];
    const result = await generateWithPolling({
        ...options(), onEvent: (event) => events.push(event),
        submit: async () => { submits++; return snapshot(); },
        poll: async (id, cursor) => {
            reads.push([id, cursor]);
            const response = responses.shift();
            if (response instanceof Error) throw response;
            return response;
        },
    });
    assert.equal(submits, 1);
    assert.deepEqual(reads, [[JOB, 0], [JOB, 2], [JOB, 2]]);
    assert.deepEqual(result, { images: done.images, seed: done.seed, generationId: 1 });
    assert.equal(events.filter((event) => event.type === 'reconnecting').length, 1);
});

test('a lost submit response is never retried', async () => {
    let submits = 0;
    await assert.rejects(generateWithPolling({
        ...options(),
        submit: async () => { submits++; throw new TypeError('fetch failed'); },
        poll: async () => assert.fail('must not poll without a job id'),
    }), /送出結果不明/);
    assert.equal(submits, 1);
});

test('session expiry and unknown jobs fail immediately instead of generating again', async () => {
    for (const status of [401, 403, 404, 409]) {
        let reads = 0;
        await assert.rejects(generateWithPolling({
            ...options(), submit: async () => snapshot(),
            poll: async () => { reads++; throw Object.assign(new Error(`HTTP ${status}`), { status }); },
        }), new RegExp(`HTTP ${status}`));
        assert.equal(reads, 1);
    }
});

test('network retries are bounded and do not duplicate the submission', async () => {
    let submits = 0;
    let reads = 0;
    await assert.rejects(generateWithPolling({
        ...options(),
        submit: async () => { submits++; return snapshot(); },
        poll: async () => { reads++; throw new TypeError('offline'); },
    }), /offline/);
    assert.equal(reads, 6);
    assert.equal(submits, 1);
});

test('generation errors and truncated terminal responses fail visibly', async () => {
    for (const [events, message] of [
        [[{ type: 'error', message: 'GPU crashed' }], /GPU crashed/],
        [[{ type: 'progress', value: 1 }], /沒有結果/],
    ]) {
        await assert.rejects(generateWithPolling({
            ...options(), submit: async () => snapshot(events, 1, true),
            poll: async () => assert.fail('already finished'),
        }), message);
    }
});

test('aborting while waiting stops reads, but never calls a server cancel API', async () => {
    const controller = new AbortController();
    let reads = 0;
    const run = generateWithPolling({
        ...options(), signal: controller.signal, delay: undefined,
        submit: async () => snapshot(),
        poll: async () => { reads++; return snapshot(); },
    });
    controller.abort(new Error('user stopped waiting'));
    await assert.rejects(run, /user stopped waiting/);
    assert.equal(reads, 0);
});

test('done in the submission snapshot needs no further request', async () => {
    const result = await generateWithPolling({
        ...options(), submit: async () => snapshot([done], 1, true),
        poll: async () => assert.fail('must not poll'),
    });
    assert.equal(result.seed, done.seed);
    assert.deepEqual(result.images, done.images);
});
