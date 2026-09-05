const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const { createNovelAI, ORIGIN } = require('./novelai.js');
const { buildNovelAIRequest, MODELS } = require('./novelai-payload.js');
const { readImages, readLimited, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL } = require('./images.js');

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const KEY = 'pst-test-only-not-a-real-key';
const payload = { prompt: 'a watercolor landscape', seed: '0' };
const imageResponse = (count = 1) => new Response(JSON.stringify({
    images: Array.from({ length: count }, (_v, index) => ({ image: PNG.toString('base64'), index, seed: index })),
}), { status: 201, headers: { 'Content-Type': 'application/json' } });

async function fixture(t, { handler = () => imageResponse(), keys = new Map([['a', KEY], ['b', 'pst-another-test-key']]), ...options } = {}) {
    const calls = [];
    const user = req => req.user.directories.root.split('/').pop();
    const secrets = {
        async read(req) { return keys.get(user(req)) || ''; },
        async write(req, value) { keys.set(user(req), value); },
        async clear(req) { keys.delete(user(req)); },
    };
    const service = createNovelAI({
        ...options, secrets,
        fetchImpl: async (url, init) => { calls.push({ url, init }); return handler(url, init); },
    });
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
        const name = req.get('x-test-user');
        if (['a', 'b'].includes(name)) req.user = { directories: { root: `/fixture/${name}` } };
        next();
    });
    service.mount(app);
    const server = await new Promise(resolve => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(async () => {
        await service.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const request = (route, body = {}, name = 'a') => fetch(`http://127.0.0.1:${server.address().port}/novelai${route}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-user': name }, body: JSON.stringify(body),
    });
    async function finished(id, name = 'a') {
        for (let i = 0; i < 100; i++) {
            const response = await request('/job', { jobId: id }, name);
            assert.equal(response.status, 200);
            const state = await response.json();
            if (state.finished) return state;
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        assert.fail('Mock job did not finish');
    }
    return { request, finished, calls, keys, service };
}

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc ^= byte;
        for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

// Small stored ZIP fixture: avoids a second ZIP implementation in production dependencies.
function zipImages(names = ['image_0.png']) {
    const locals = [], centrals = [];
    let offset = 0;
    for (const name of names) {
        const filename = Buffer.from(name);
        const local = Buffer.alloc(30), central = Buffer.alloc(46);
        local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
        local.writeUInt32LE(crc32(PNG), 14); local.writeUInt32LE(PNG.length, 18); local.writeUInt32LE(PNG.length, 22);
        local.writeUInt16LE(filename.length, 26);
        central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
        central.writeUInt32LE(crc32(PNG), 16); central.writeUInt32LE(PNG.length, 20); central.writeUInt32LE(PNG.length, 24);
        central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
        locals.push(local, filename, PNG); centrals.push(central, filename);
        offset += local.length + filename.length + PNG.length;
    }
    const directory = Buffer.concat(centrals), end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
    end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

test('independent per-user tokens: store, status, delete; no token appears in responses', async (t) => {
    const { request, calls, keys } = await fixture(t, { keys: new Map() });
    assert.equal((await request('/status', {}, 'anonymous')).status, 401);
    assert.equal((await (await request('/status')).json()).configured, false);
    const stored = await request('/token', { token: KEY });
    assert.deepEqual(await stored.json(), { ok: true, configured: true });
    assert.equal((await (await request('/status', {}, 'b')).json()).configured, false);
    assert.equal((await request('/token', { token: 'bad\nkey' })).status, 400);
    assert.equal(keys.get('a'), KEY);
    const status = await (await request('/status')).text();
    assert.ok(!status.includes(KEY));
    assert.equal((await request('/token', { clear: true })).status, 200);
    assert.equal(keys.has('a'), false);
    assert.equal(calls.length, 0);
    assert.equal((await request('/jobs', { payload })).status, 400);
});

test('official JSON generation preserves V4.5 prompts, zero seed, multiple PNGs and only submits once', async (t) => {
    const { request, finished, calls } = await fixture(t, { handler: () => imageResponse(2) });
    const response = await request('/jobs', { payload: { ...payload, n_samples: 2, width: 832, height: 1216, negative_prompt: 'blurry' }, baseUrl: 'https://never-use.invalid' });
    assert.equal(response.status, 202);
    const first = await response.json();
    assert.match(first.job_id, /^[a-f0-9]{32}$/);
    const result = await finished(first.job_id);
    const done = result.events.at(-1);
    assert.equal(done.type, 'done');
    assert.equal(done.images.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ORIGIN}/ai/generate-image`);
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.Authorization, `Bearer ${KEY}`);
    assert.equal(calls[0].init.headers.Accept, 'application/json');
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'nai-diffusion-4-5-full');
    assert.equal(body.action, 'generate');
    assert.equal(body.parameters.seed, 0);
    assert.equal(body.parameters.v4_prompt.caption.base_caption, payload.prompt);
    assert.equal(body.parameters.v4_negative_prompt.caption.base_caption, 'blurry');
    assert.ok(!calls[0].init.body.includes(KEY));
    for (const [i, path] of done.images.entries()) {
        const file = await (await request('/output', { path })).json();
        assert.deepEqual(Buffer.from(file.data, 'base64'), PNG);
        assert.equal(file.seed, String(i));
        assert.equal(file.mime, 'image/png');
    }
    const incremental = await (await request('/job', { jobId: first.job_id, after: result.next_cursor })).json();
    assert.deepEqual(incremental.events, []);
    assert.equal((await request('/job', { jobId: first.job_id, after: 999 })).status, 400);
});

test('ZIP response is decoded in memory and served as PNG', async (t) => {
    const { request, finished } = await fixture(t, { handler: () => new Response(zipImages(), { status: 201, headers: { 'Content-Type': 'application/zip' } }) });
    const { job_id } = await (await request('/jobs', { payload })).json();
    const result = await finished(job_id);
    assert.equal(result.events.at(-1).type, 'done');
    const file = await (await request('/output', { path: result.events.at(-1).images[0] })).json();
    assert.deepEqual(Buffer.from(file.data, 'base64'), PNG);
});

test('connection test is only a tag suggestion GET and cannot generate or leak a token', async (t) => {
    const { request, calls } = await fixture(t, { handler: () => Response.json({ tags: [] }) });
    const response = await request('/test');
    assert.equal(response.status, 200);
    assert.ok(!(await response.text()).includes(KEY));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'GET');
    assert.match(calls[0].url, /^https:\/\/image\.novelai\.net\/ai\/generate-image\/suggest-tags\?/);
});

test('bad payloads are rejected before contacting NovelAI', async (t) => {
    const { request, calls } = await fixture(t);
    const invalid = [null, [], {}, { ...payload, prompt: ' ' }, { ...payload, width: 65 }, { ...payload, width: 2048, height: 2048 },
        { ...payload, n_samples: 5 }, { ...payload, steps: 0 }, { ...payload, steps: 1.2 }, { ...payload, model: 'unknown' },
        { ...payload, sampler: 'unknown' }, { ...payload, noise_schedule: 'unknown' }, { ...payload, seed: '18446744073709551613' },
        { ...payload, seed: '1.5' }, { ...payload, seed: null }, { ...payload, seed: true }, { ...payload, scale: 'five' },
        { ...payload, cfg_rescale: 2 }, { ...payload, url: 'https://bad.invalid' }, { ...payload, token: KEY }];
    for (const item of invalid) assert.equal((await request('/jobs', { payload: item })).status, 400, JSON.stringify(item));
    assert.equal(calls.length, 0);
});

test('supported model payloads, random 32-bit seeds and V3 without V4 fields', () => {
    for (const model of MODELS) {
        const request = buildNovelAIRequest({ prompt: 'landscape', model, seed: '-1' });
        assert.ok(Number.isInteger(request.parameters.seed));
        assert.ok(request.parameters.seed >= 0 && request.parameters.seed <= 0xffffffff);
        assert.equal(Boolean(request.parameters.v4_prompt), model.startsWith('nai-diffusion-4'));
    }
    assert.equal(buildNovelAIRequest({ ...payload, seed: '4294967295' }).parameters.seed, 4294967295);
});

test('upstream authentication, billing, rate limit and server errors never retry or echo error bodies', async (t) => {
    for (const status of [400, 401, 402, 403, 422, 429, 500, 524]) {
        await t.test(`HTTP ${status}`, async (t) => {
            const { request, finished, calls } = await fixture(t, { handler: () => new Response(`private ${KEY}`, { status }) });
            const { job_id } = await (await request('/jobs', { payload })).json();
            const state = await finished(job_id);
            const error = state.events.at(-1);
            assert.equal(error.type, 'error');
            assert.equal(error.status, status < 500 ? status : 502);
            assert.match(error.message, new RegExp(`HTTP ${status}`));
            assert.ok(!JSON.stringify(state).includes(KEY));
            assert.equal(calls.length, 1);
        });
    }
});

test('jobs and output are isolated by authenticated owner; concurrent account generation is refused', async (t) => {
    let release;
    const handler = (_url, init) => new Promise((resolve, reject) => {
        release = () => resolve(imageResponse());
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
    const { request, finished, calls, keys } = await fixture(t, { handler });
    const { job_id } = await (await request('/jobs', { payload })).json();
    assert.equal((await request('/jobs', { payload })).status, 409);
    keys.set('b', KEY);
    assert.equal((await request('/jobs', { payload }, 'b')).status, 409);
    assert.equal((await request('/job', { jobId: job_id }, 'b')).status, 404);
    assert.equal((await request('/output', { path: `${job_id}/0.png` }, 'b')).status, 404);
    assert.equal((await request('/job', { jobId: '../../x' })).status, 400);
    assert.equal((await request('/output', { path: '../secrets.json' })).status, 400);
    release();
    await finished(job_id);
    assert.equal((await request('/output', { path: `${job_id}/0.png` }, 'b')).status, 404);
    assert.equal(calls.length, 1);
});

test('fetch and response-body timeouts finish the job without another submission', async (t) => {
    for (const phase of ['headers', 'body']) {
        await t.test(phase, async (t) => {
            const handler = (_url, init) => phase === 'headers' ? new Promise((_resolve, reject) => {
                init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
            }) : new Response(new ReadableStream({ start(controller) {
                init.signal.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
            } }), { headers: { 'Content-Type': 'application/json' } });
            const { request, finished, calls } = await fixture(t, { handler, timeoutMs: 20 });
            const { job_id } = await (await request('/jobs', { payload })).json();
            assert.equal((await finished(job_id)).events.at(-1).status, 504);
            assert.equal(calls.length, 1);
        });
    }
});

test('capacity is checked before paid submission; expired jobs release capacity', async (t) => {
    let time = 0;
    const { request, finished, calls } = await fixture(t, { now: () => time, retentionMs: 1000, maxJobs: 1 });
    const { job_id } = await (await request('/jobs', { payload })).json();
    await finished(job_id);
    assert.equal((await request('/jobs', { payload })).status, 503);
    assert.equal(calls.length, 1);
    time = 1001;
    assert.equal((await request('/job', { jobId: job_id })).status, 404);
    const next = await request('/jobs', { payload });
    assert.equal(next.status, 202);
    await finished((await next.json()).job_id);
    assert.equal(calls.length, 2);
});

test('memory budget and shutdown prevent unbounded pending work', async (t) => {
    const tiny = await fixture(t, { maxCacheBytes: MAX_IMAGE_TOTAL - 1 });
    assert.equal((await tiny.request('/jobs', { payload })).status, 503);
    assert.equal(tiny.calls.length, 0);
    const hanging = await fixture(t, { handler: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }) });
    const { job_id } = await (await hanging.request('/jobs', { payload })).json();
    await hanging.service.close();
    assert.equal((await hanging.request('/job', { jobId: job_id })).status, 404);
    assert.equal(hanging.calls.length, 1);
});

test('image parsing rejects empty/malformed/oversized bodies, wrong PNGs and excessive ZIP entries', async () => {
    for (const response of [new Response(''), new Response('x'), new Response('not zip'), Response.json({ images: [] }),
        Response.json({ images: [{ image: '!!!!' }] }), Response.json({ images: [{ image: Buffer.from('<svg/>').toString('base64') }] }),
        new Response('broken', { headers: { 'Content-Type': 'application/json' } }),
        new Response(zipImages(['a.png', 'b.png']), { headers: { 'Content-Type': 'application/zip' } }),
        new Response(zipImages(['readme.txt']), { headers: { 'Content-Type': 'application/zip' } }),
        new Response(zipImages(['../escape.png']), { headers: { 'Content-Type': 'application/zip' } })]) {
        await assert.rejects(readImages(response, 1), error => error.status === 502);
    }
    await assert.rejects(readLimited(new Response('123456789'), 8), /大小限制/);
    await assert.rejects(readLimited(new Response('x', { headers: { 'Content-Length': '999999999' } }), 8), /大小限制/);
    const zip = zipImages();
    const central = zip.indexOf(Buffer.from('504b0102', 'hex'));
    zip.writeUInt32LE(MAX_IMAGE_BYTES + 1, central + 24);
    await assert.rejects(readImages(new Response(zip)), error => error.status === 502);
});
