const assert = require('node:assert/strict');
const { test } = require('node:test');
const express = require('express');
const plugin = require('./index.js');

const JOB = 'a'.repeat(32);
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

async function listen(app, t) {
    const server = await new Promise((resolve) => {
        const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    t.after(async () => {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, { old = false, failStatus = 0 } = {}) {
    await plugin.exit();
    t.after(() => plugin.exit());
    const calls = { logins: 0, submits: [], polls: [], legacy: 0, rejectNextPoll: false };
    const upstream = express();
    upstream.use(express.json());
    upstream.post('/api/login', (req, res) => {
        calls.logins++;
        if (req.body.password !== 'test-password') return res.sendStatus(401);
        res.setHeader('Set-Cookie', 'comfyui_ui_session=test-token; HttpOnly; Path=/');
        res.json({ ok: true });
    });
    upstream.use((req, res, next) => {
        if (req.headers.cookie !== 'comfyui_ui_session=test-token') return res.sendStatus(401);
        next();
    });
    upstream.get('/api/queue', (_req, res) => res.json({ waiting: 0, generation_transports: old ? ['sse'] : ['poll', 'sse'] }));
    upstream.get('/api/presets', (_req, res) => res.json({ presets: [{ name: '範例' }] }));
    upstream.get('/api/presets/:name', (req, res) => res.json({ name: req.params.name, seed: '18446744073709551613' }));
    upstream.get('/api/schema', (_req, res) => res.json({ options_resolved: false }));
    upstream.post('/api/generate/jobs', (req, res) => {
        if (old) return res.sendStatus(404);
        if (failStatus) return res.status(failStatus).type('text').send('Cloudflare upstream unavailable');
        calls.submits.push(req.body);
        res.status(202).json({ job_id: JOB, events: [], next_cursor: 0, finished: false });
    });
    upstream.get('/api/generate/jobs/:id', (req, res) => {
        calls.polls.push({ id: req.params.id, after: req.query.after });
        if (calls.rejectNextPoll) {
            calls.rejectNextPoll = false;
            return res.sendStatus(401);
        }
        if (req.params.id !== JOB) return res.status(404).json({ detail: 'No such generation job' });
        res.json({ job_id: JOB, events: [{ type: 'done', images: ['7/a.png'], seed: '18446744073709551613' }], next_cursor: 1, finished: true });
    });
    upstream.post('/api/generate', (_req, res) => {
        calls.legacy++;
        res.type('text/event-stream').end('data: {"type":"done","images":["7/a.png"]}\n\n');
    });
    upstream.get('/api/output/:id/:filename', (_req, res) => res.type('png').send(PNG));
    const upstreamUrl = await listen(upstream, t);
    const app = express();
    app.use(express.json());
    const router = express.Router();
    await plugin.init(router);
    app.use('/api/plugins/sillytavern-custom-text2img', router);
    const proxyUrl = await listen(app, t);
    const request = (path, body = {}) => fetch(`${proxyUrl}/api/plugins/sillytavern-custom-text2img${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl: upstreamUrl, password: 'test-password', ...body }),
    });
    return { calls, request, proxyUrl, upstreamUrl };
}

test('login, presets, schema, jobs, progress and image bytes use JSON HTTP', async (t) => {
    const { request, calls, proxyUrl } = await fixture(t);
    const probe = await fetch(`${proxyUrl}/api/plugins/sillytavern-custom-text2img/probe`);
    const capability = await probe.json();
    assert.equal(capability.id, 'sillytavern-custom-text2img');
    assert.equal(capability.version, require('./package.json').version);
    assert.deepEqual(capability.providers, ['comfy-modal', 'novelai']);
    const check = await request('/test');
    assert.equal((await check.json()).generation_transport, 'poll');
    assert.match(check.headers.get('cache-control'), /no-store/);
    assert.equal((await (await request('/presets')).json()).presets[0].name, '範例');
    assert.equal((await (await request('/preset', { name: '範例' })).json()).name, '範例');
    assert.equal((await (await request('/schema')).json()).options_resolved, false);
    const payload = { prompt_text: 'test', seed: '18446744073709551613', loras: [], batch_size: 2 };
    const submitted = await request('/jobs', { payload });
    assert.equal(submitted.status, 202);
    assert.match(submitted.headers.get('content-type'), /application\/json/);
    assert.equal((await submitted.json()).job_id, JOB);
    const progress = await request('/job', { jobId: JOB, after: 0 });
    assert.equal((await progress.json()).events[0].seed, payload.seed);
    const image = await (await request('/output', { path: '7/a.png' })).json();
    assert.deepEqual(Buffer.from(image.data, 'base64'), PNG);
    assert.deepEqual(calls.submits, [payload]);
    assert.deepEqual(calls.polls, [{ id: JOB, after: '0' }]);
    assert.equal(calls.logins, 1);
    assert.equal(calls.legacy, 0);
});

test('HTTPS trycloudflare base URL is retained for every upstream operation', async (t) => {
    const { request, upstreamUrl } = await fixture(t);
    const originalFetch = global.fetch;
    const tunnel = 'https://test-panel.trycloudflare.com';
    const urls = [];
    t.mock.method(global, 'fetch', (url, init) => {
        if (String(url).startsWith(tunnel)) {
            urls.push(String(url));
            return originalFetch(String(url).replace(tunnel, upstreamUrl), init);
        }
        return originalFetch(url, init);
    });
    assert.equal((await request('/jobs', { baseUrl: `${tunnel}/`, payload: { prompt_text: 'remote' } })).status, 202);
    assert.equal((await request('/job', { baseUrl: tunnel, jobId: JOB, after: 0 })).status, 200);
    assert.equal((await request('/output', { baseUrl: tunnel, path: '7/a.png' })).status, 200);
    assert.deepEqual(urls, [
        `${tunnel}/api/login`, `${tunnel}/api/generate/jobs`,
        `${tunnel}/api/generate/jobs/${JOB}?after=0`, `${tunnel}/api/output/7/a.png`,
    ]);
});

test('expired panel cookie reauthenticates without resubmitting the GPU job', async (t) => {
    const { request, calls } = await fixture(t);
    await request('/jobs', { payload: { prompt_text: 'once' } });
    calls.rejectNextPoll = true;
    const result = await request('/job', { jobId: JOB, after: 0 });
    assert.equal(result.status, 200);
    assert.equal(calls.logins, 2);
    assert.equal(calls.submits.length, 1);
    assert.equal(calls.polls.length, 2);
});

test('old image server gives an actionable update error, never an SSE fallback', async (t) => {
    const { request, calls } = await fixture(t, { old: true });
    const check = await (await request('/test')).json();
    assert.equal(check.generation_transport, 'sse');
    assert.match(check.warning, /generation-jobs/);
    const response = await request('/jobs', { payload: { prompt_text: 'x' } });
    assert.equal(response.status, 409);
    assert.match((await response.json()).error, /ui_server.py/);
    assert.equal(calls.legacy, 0);
});

test('invalid input is rejected before upstream traffic and absent jobs stay 404', async (t) => {
    const { request, calls } = await fixture(t);
    assert.equal((await request('/jobs', { payload: [] })).status, 400);
    assert.equal((await request('/jobs', { baseUrl: 'https://host/?token=x', payload: { prompt_text: 'x' } })).status, 400);
    assert.equal((await request('/jobs', { baseUrl: 'https://user:pass@host/', payload: { prompt_text: 'x' } })).status, 400);
    assert.equal((await request('/job', { jobId: '../../login' })).status, 400);
    assert.equal((await request('/job', { jobId: JOB, after: -1 })).status, 400);
    assert.equal(calls.logins, 0);
    assert.equal((await request('/job', { jobId: 'b'.repeat(32) })).status, 404);
    assert.equal((await request('/test', { password: 'wrong' })).status, 401);
});

test('Cloudflare non-JSON failures remain informative and are not resubmitted', async (t) => {
    const { request, calls } = await fixture(t, { failStatus: 524 });
    const response = await request('/jobs', { payload: { prompt_text: 'x' } });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /HTTP 524: Cloudflare upstream unavailable/);
    assert.equal(calls.legacy, 0);
});

test('legacy local SSE route stays compatible', async (t) => {
    const { request, calls } = await fixture(t);
    const response = await request('/generate', { payload: { prompt_text: 'legacy' } });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    assert.match(response.headers.get('cache-control'), /no-transform/);
    assert.match(await response.text(), /"type":"done"/);
    assert.equal(calls.legacy, 1);
});
