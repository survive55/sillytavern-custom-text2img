import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';
import { createNovelAI, NOVELAI_ORIGIN } from '../novelai.js';
import { buildNovelAIRequest, MODELS, SAMPLERS, SCHEDULES } from '../novelai-payload.js';
import { createPanelClient, normalizePanelUrl } from '../panel.js';
import { readImages, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL, MAX_REPLY_BYTES } from '../images.js';
import { PNG_BASE64, PNG_BYTES, JOB_ID, makeZip, panelLogin, finishJob } from './fixtures.mjs';

const oldPayload = createRequire(import.meta.url)('../../server/novelai-payload.js').buildNovelAIRequest;
const PAYLOAD = { prompt: 'landscape, sunrise', negative_prompt: 'blur', seed: '0', n_samples: 2 };

test('browser payload preserves every old model/sampler/schedule and all explicit parameters exactly', () => {
    for (const model of MODELS) for (const sampler of SAMPLERS) for (const noise_schedule of SCHEDULES) {
        const payload = { ...PAYLOAD, model, sampler, noise_schedule, steps: 21, scale: 0, cfg_rescale: 0.7, width: 832, height: 1216 };
        assert.deepEqual(buildNovelAIRequest(payload), oldPayload(payload));
    }
    for (const seed of ['', '-1', -1, undefined]) {
        const request = buildNovelAIRequest({ prompt: 'test', seed });
        assert.ok(Number.isInteger(request.parameters.seed) && request.parameters.seed >= 0 && request.parameters.seed <= 0xffffffff);
    }
    for (const extra of [{ width: 63 }, { n_samples: 5 }, { cfg_rescale: 2 }, { width: 2048, height: 2048 }, { seed: '4294967296' },
        { url: 'https://wrong.invalid' }, { token: 'do-not-forward' }, { steps: NaN }, { prompt: '' }]) {
        assert.throws(() => buildNovelAIRequest({ ...PAYLOAD, ...extra }));
    }
});

test('NovelAI uses only the official origin, preserves all images/seeds and never needs ST or a panel', async t => {
    const calls = [];
    const api = createNovelAI({ locks: null, fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return Response.json({ images: [{ image: PNG_BASE64, seed: 0 }, { image: PNG_BASE64, seed: 1 }] });
    } });
    t.after(() => api.close());
    const client = api.client('fake-novel-token');
    const accepted = await client.submit(PAYLOAD);
    const done = await finishJob(client, accepted.job_id);
    assert.equal(calls.length, 1);
    const { url, init } = calls[0];
    assert.equal(url, `${NOVELAI_ORIGIN}/ai/generate-image`);
    assert.equal(init.credentials, 'omit'); assert.equal(init.mode, 'cors'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer fake-novel-token');
    assert.equal(init.headers.Cookie, undefined); assert.equal(init.headers['X-CSRF-Token'], undefined);
    assert.deepEqual(JSON.parse(init.body), oldPayload(PAYLOAD));
    const event = done.events.at(-1);
    assert.equal(event.type, 'done'); assert.equal(event.seed, '0'); assert.equal(event.images.length, 2);
    for (let i = 0; i < 2; i++) {
        const image = await client.output(event.images[i]);
        assert.equal(image.seed, String(i)); assert.equal(image.data, PNG_BASE64);
    }
    assert.ok(!JSON.stringify(done).includes('fake-novel-token'));
    await assert.rejects(api.client('other').poll(accepted.job_id, 0), /不存在/);
});

test('NovelAI JSON and native ZIP decoding preserve multi-image results without node libraries', async () => {
    for (const compressed of [true, false]) {
        const zip = makeZip([{ name: 'image_0.png', data: PNG_BYTES }, { name: '../image_1.png', data: PNG_BYTES }], { compressed });
        const files = await readImages(new Response(zip, { headers: { 'Content-Type': 'application/zip' } }), 2);
        assert.equal(files.length, 2);
        for (const file of files) assert.deepEqual(Buffer.from(file.bytes), PNG_BYTES);
    }
    assert.equal((await readImages(Response.json({ images: [{ image: PNG_BASE64, seed: 4294967295 }] })))[0].seed, '4294967295');
});

test('NovelAI rejects malformed, empty, excessive and oversized responses with bounded decoding', async () => {
    const cases = [
        Response.json({ images: [] }), Response.json({ images: [{ image: '<html>' }] }),
        Response.json({ images: [{ image: Buffer.from('not png').toString('base64') }] }),
        Response.json({ images: Array.from({ length: 5 }, () => ({ image: PNG_BASE64 })) }),
        new Response('{bad json', { headers: { 'Content-Type': 'application/json' } }),
        new Response('bad', { headers: { 'Content-Length': String(MAX_REPLY_BYTES + 1) } }),
        new Response(makeZip(Array.from({ length: 33 }, (_, i) => ({ name: `${i}.txt`, data: Buffer.from('x') })))),
        new Response(makeZip([{ name: 'large.png', data: Buffer.alloc(MAX_IMAGE_BYTES + 1) }], { compressed: true })),
        new Response(makeZip([{ name: 'no-png.txt', data: Buffer.from('x') }])),
    ];
    const corrupted = makeZip();
    corrupted[corrupted.length - 22 - Buffer.byteLength('image_0.png') - 46 + 16] ^= 1;
    cases.push(new Response(corrupted));
    for (const response of cases) await assert.rejects(readImages(response));
    let cancelled = false;
    const oversize = new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new Uint8Array(MAX_REPLY_BYTES + 1));
    }, cancel() { cancelled = true; } }));
    await assert.rejects(readImages(oversize), /大小限制/);
    assert.equal(cancelled, true);
});

test('connection test is read-only and never generates an image', async t => {
    const calls = [];
    const api = createNovelAI({ locks: null, fetchImpl: async (url, init) => { calls.push({ url, init }); return Response.json({ tags: [] }); } });
    t.after(() => api.close());
    const result = await api.client('fake').test();
    assert.match(result.message, /未生圖/); assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'GET'); assert.match(calls[0].url, /\/ai\/generate-image\/suggest-tags\?/);
    assert.equal(calls[0].init.body, undefined);
});

test('billing/auth/network errors never retry or echo secrets, even when the direct response fails', async t => {
    for (const code of [400, 401, 402, 403, 422, 429, 500, 524, 'network']) {
        let count = 0;
        const api = createNovelAI({ locks: null, fetchImpl: async () => {
            count++; if (code === 'network') throw new TypeError('private network message');
            return new Response('fake-token private-prompt', { status: code });
        } });
        t.after(() => api.close());
        const client = api.client('fake-token');
        const accepted = await client.submit({ ...PAYLOAD, n_samples: 1 });
        const done = await finishJob(client, accepted.job_id);
        assert.equal(done.events.at(-1).type, 'error'); assert.equal(count, 1);
        assert.doesNotMatch(JSON.stringify(done), /fake-token|private-prompt|private network message/);
    }
});

test('stop-waiting does not abort/resubmit the paid fetch; concurrency is refused until it finishes', async t => {
    let resolveFetch, init;
    const api = createNovelAI({ locks: null, fetchImpl: (_url, options) => { init = options; return new Promise(resolve => { resolveFetch = resolve; }); } });
    t.after(() => api.close());
    const client = api.client('fake');
    const controller = new AbortController();
    const accepted = await client.submit({ ...PAYLOAD, n_samples: 1 }, controller.signal);
    controller.abort();
    await assert.rejects(client.poll(accepted.job_id, 0, controller.signal));
    assert.equal(init.signal.aborted, false);
    await assert.rejects(api.client('different-token').submit(PAYLOAD), /進行中/);
    resolveFetch(Response.json({ images: [{ image: PNG_BASE64 }] }));
    assert.equal((await finishJob(client, accepted.job_id)).events.at(-1).type, 'done');
});

test('response-body deadlines finish the job and release capacity without retrying', async t => {
    let calls = 0, cancelled = false;
    const api = createNovelAI({ locks: null, timeoutMs: 20, fetchImpl: async () => {
        calls++; return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
    } });
    t.after(() => api.close());
    const client = api.client('fake'), accepted = await client.submit(PAYLOAD);
    const done = await finishJob(client, accepted.job_id);
    assert.equal(done.events.at(-1).status, 504); assert.equal(cancelled, true); assert.equal(calls, 1); assert.equal(api.busy, false);
});

test('cache budgets, expiry, malformed payloads and cross-tab locks are checked before paid traffic', async t => {
    let calls = 0, time = 1000;
    const fetchImpl = async () => { calls++; return Response.json({ images: [{ image: PNG_BASE64 }] }); };
    const tooSmall = createNovelAI({ locks: null, maxCacheBytes: MAX_IMAGE_TOTAL - 1, fetchImpl });
    t.after(() => tooSmall.close());
    await assert.rejects(tooSmall.client('fake').submit(PAYLOAD), /暫存/);
    assert.equal(calls, 0);
    const api = createNovelAI({ locks: null, maxJobs: 1, now: () => time, retentionMs: 10, fetchImpl });
    t.after(() => api.close());
    const client = api.client('fake');
    await assert.rejects(client.submit({ ...PAYLOAD, n_samples: 5 })); assert.equal(calls, 0);
    const first = await client.submit(PAYLOAD); await finishJob(client, first.job_id);
    await assert.rejects(client.submit(PAYLOAD), /暫存/);
    time += 11;
    const second = await client.submit(PAYLOAD); await finishJob(client, second.job_id);
    assert.equal(calls, 2);
    const busy = createNovelAI({ fetchImpl, locks: { request: async (_name, _options, callback) => callback(null) } });
    t.after(() => busy.close());
    await assert.rejects(busy.client('fake').submit(PAYLOAD), /另一個/); assert.equal(calls, 2);
});

test('panel browser transport covers login, presets, schema, polling and images without ST cookies', async () => {
    const calls = [];
    const client = createPanelClient({ baseUrl: 'https://panel.trycloudflare.com', password: 'panel-password' }, { fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.endsWith('/login')) return panelLogin();
        if (url.endsWith('/queue')) return Response.json({ waiting: 2, generation_transports: ['poll'] });
        if (url.endsWith('/presets')) return Response.json({ presets: [{ name: 'illustration' }] });
        if (url.endsWith('/presets/illustration')) return Response.json({ loras: [{ name: 'test' }] });
        if (url.includes('/schema')) return Response.json({ groups: [] });
        if (url.endsWith('/generate/jobs')) return Response.json({ job_id: JOB_ID, next_cursor: 1, finished: false, events: [{ type: 'accepted' }] }, { status: 202 });
        if (url.includes(`/generate/jobs/${JOB_ID}`)) return Response.json({ job_id: JOB_ID, next_cursor: 2, finished: true, events: [{ type: 'done', images: ['1/a.png'] }] });
        if (url.includes('/output/')) return new Response(PNG_BYTES, { headers: { 'Content-Type': 'image/png' } });
        assert.fail(url);
    } });
    assert.equal((await client.test()).waiting, 2);
    assert.equal((await client.presets()).presets.length, 1);
    assert.equal((await client.preset('illustration')).loras[0].name, 'test');
    await client.schema();
    const payload = { prompt_text: 'scene', seed: '18446744073709551613', loras: [{ name: 'test', strength: 0.5 }], batch_size: 2 };
    await client.submit(payload); await client.poll(JOB_ID, 1);
    assert.equal((await client.output('1/a.png')).data, PNG_BASE64);
    assert.equal(calls.filter(call => call.url.endsWith('/login')).length, 1);
    assert.deepEqual(JSON.parse(calls.find(call => call.url.endsWith('/generate/jobs')).init.body), payload);
    for (const { url, init } of calls) {
        assert.ok(url.startsWith('https://panel.trycloudflare.com/api/browser/'));
        assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error'); assert.equal(init.headers.Cookie, undefined);
        assert.equal(init.headers['X-CSRF-Token'], undefined);
        if (!url.endsWith('/login')) assert.ok(!JSON.stringify(init).includes('panel-password'));
    }
});

test('panel expired reads reauthenticate once but a POST/network failure never resubmits', async () => {
    let logins = 0, reads = 0, posts = 0;
    const client = createPanelClient({ baseUrl: 'https://panel.example', password: 'pw' }, { fetchImpl: async (url, init) => {
        if (url.endsWith('/login')) { logins++; return panelLogin(); }
        if (init.method === 'GET') { reads++; return reads === 1 ? new Response('', { status: 401 }) : Response.json({ presets: [] }); }
        posts++; return new Response('', { status: 401 });
    } });
    await client.presets(); assert.equal(logins, 2); assert.equal(reads, 2);
    await assert.rejects(client.submit({ prompt_text: 'paid job' }), /密碼/);
    assert.equal(posts, 1); assert.equal(logins, 2);
    const lost = createPanelClient({ baseUrl: 'https://panel.example', password: 'pw' }, { fetchImpl: async url => {
        if (url.endsWith('/login')) return panelLogin();
        posts++; throw new TypeError('connection lost');
    } });
    await assert.rejects(lost.submit({ prompt_text: 'paid job' }), /無法直連/);
    assert.equal(posts, 2);
});

test('an old panel gives an actionable upgrade error and never falls back to an ST server plugin', async () => {
    const calls = [];
    const client = createPanelClient({ baseUrl: 'https://old-panel.example', password: 'pw' }, { fetchImpl: async url => {
        calls.push(url); return Response.json({ detail: 'Not Found' }, { status: 404 });
    } });
    await assert.rejects(client.test(), /請更新控制面板.*不需要安裝 ST 後端插件/);
    assert.deepEqual(calls, ['https://old-panel.example/api/browser/login']);
});

test('panel rejects insecure/extraneous URL credentials and unsafe output paths before external traffic', async () => {
    assert.equal(normalizePanelUrl(' http://127.0.0.1:8800/ '), 'http://127.0.0.1:8800');
    for (const url of ['file:///tmp/x', 'https://user:pw@panel.example', 'https://panel.example?a=b', 'http://public.example', 'https://panel.example#x']) {
        assert.throws(() => normalizePanelUrl(url));
    }
    let calls = 0;
    const client = createPanelClient({ baseUrl: 'https://panel.example', password: 'pw' }, { fetchImpl: async () => { calls++; assert.fail('No traffic expected'); } });
    for (const path of ['/etc/passwd', '../secrets', '1/../x', '1\\x', '1//x']) await assert.rejects(client.output(path));
    assert.throws(() => client.submit({ prompt_text: '' }));
    assert.throws(() => client.poll('invalid', 0)); assert.equal(calls, 0);
});
