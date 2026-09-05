import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildManualLlmUrl, createManualLlmClient, ManualLlmError, parseExtraHeaders } from '../manual-llm.js';

const settings = {
    manualLlmBaseUrl: 'https://api.example.com/v1/',
    manualLlmPath: '/chat/completions',
    manualLlmModel: 'example-model',
    manualLlmApiKey: 'test-secret-key',
    manualLlmApiKeyHeader: 'Authorization',
    manualLlmApiKeyPrefix: 'Bearer',
    manualLlmExtraHeaders: '{"HTTP-Referer":"https://st.example","X-Title":"Custom Text2Img"}',
};

test('manual OpenAI-compatible client sends the configured URL, model, key header and messages', async () => {
    const calls = [];
    const client = createManualLlmClient({ fetchImpl: async (url, init) => {
        calls.push({ url, init, body: JSON.parse(init.body) });
        return Response.json({ choices: [{ message: { content: '1girl, forest, sunrise' } }] });
    } });
    const messages = [{ role: 'system', content: 'tags only' }, { role: 'user', content: 'scene' }];
    const result = await client.send(settings, messages, 321, new AbortController().signal);
    assert.equal(result, '1girl, forest, sunrise');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.example.com/v1/chat/completions');
    assert.equal(calls[0].init.credentials, 'omit');
    assert.equal(calls[0].init.redirect, 'error');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer test-secret-key');
    assert.equal(calls[0].init.headers['HTTP-Referer'], 'https://st.example');
    assert.deepEqual(calls[0].body, { model: 'example-model', messages, max_tokens: 321, stream: false });
});

test('custom API key header and empty prefix support non-Bearer compatible services', async () => {
    let request;
    const client = createManualLlmClient({ fetchImpl: async (_url, init) => {
        request = init;
        return Response.json({ choices: [{ message: { content: [{ type: 'text', text: 'OK' }] } }] });
    } });
    const result = await client.send({ ...settings, manualLlmApiKeyHeader: 'api-key', manualLlmApiKeyPrefix: '', manualLlmExtraHeaders: '' }, [{ role: 'user', content: 'test' }], 8);
    assert.equal(result, 'OK');
    assert.equal(request.headers['api-key'], 'test-secret-key');
    assert.equal(request.headers.Authorization, undefined);
});

test('URL and header validation reject credential leaks and insecure remote endpoints before fetch', async () => {
    assert.equal(buildManualLlmUrl('http://127.0.0.1:1234/v1', 'chat/completions'), 'http://127.0.0.1:1234/v1/chat/completions');
    assert.throws(() => buildManualLlmUrl('http://api.example.com/v1'), /HTTPS/);
    assert.throws(() => buildManualLlmUrl('https://user:pass@example.com/v1'), /帳密/);
    assert.throws(() => buildManualLlmUrl('https://api.example.com/v1', 'https://evil.example/steal'), /相對/);
    assert.throws(() => parseExtraHeaders('{"Content-Type":"text/plain"}'), /不允許/);
    assert.throws(() => parseExtraHeaders('{"Cookie":"secret"}'), /不允許/);
    assert.throws(() => parseExtraHeaders('{"Sec-Fetch-Site":"cross-site"}'), /不允許/);
    assert.throws(() => parseExtraHeaders('{"X-Test":"ok\\r\\nInjected: yes"}'), /無效/);
    let calls = 0;
    const client = createManualLlmClient({ fetchImpl: async () => { calls++; return Response.json({}); } });
    await assert.rejects(client.send({ ...settings, manualLlmBaseUrl: 'http://remote.example/v1' }, [], 10), ManualLlmError);
    assert.equal(calls, 0);
});

test('pre-aborted requests and forbidden key headers never invoke fetch', async () => {
    let calls = 0;
    const client = createManualLlmClient({ fetchImpl: async () => { calls++; return Response.json({}); } });
    const controller = new AbortController();
    controller.abort('cancelled before send');
    await assert.rejects(client.send(settings, [], 10, controller.signal), /已取消/);
    await assert.rejects(client.send({ ...settings, manualLlmApiKeyHeader: 'Cookie' }, [], 10), /不允許/);
    await assert.rejects(client.send({ ...settings, manualLlmApiKeyHeader: 'Content-Type' }, [], 10), /不允許/);
    assert.equal(calls, 0);
});

test('successful response bodies are bounded before JSON decoding', async () => {
    const oversized = createManualLlmClient({ fetchImpl: async () => new Response('x'.repeat(2 * 1024 * 1024 + 1), {
        headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) },
    }) });
    await assert.rejects(oversized.send(settings, [], 10), /大小限制/);
});

test('upstream errors and malformed responses never expose response bodies or API keys', async () => {
    const secretBody = 'upstream says test-secret-key is invalid';
    const failing = createManualLlmClient({ fetchImpl: async () => new Response(secretBody, { status: 401 }) });
    await assert.rejects(failing.send(settings, [], 10), error => {
        assert.match(error.message, /HTTP 401/);
        assert.doesNotMatch(error.message, /test-secret-key|upstream says/);
        return true;
    });
    const malformed = createManualLlmClient({ fetchImpl: async () => Response.json({ choices: [] }) });
    await assert.rejects(malformed.send(settings, [], 10), /choices\[0\]/);
});
