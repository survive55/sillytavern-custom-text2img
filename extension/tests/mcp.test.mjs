import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMcpClient, MCP_DEFAULTS, MCP_VERSION, mcpUrl, buildMcpPayload } from '../mcp-client.js';
import { createMcpImages, decodeMcpImages } from '../mcp-images.js';
import { runMcpPromptLoop, decodeToolTurn, sendMcpTurn, assertMcpLlmSupport, profileFingerprint } from '../mcp-prompts.js';
import { createManualLlmClient } from '../manual-llm.js';
import { PNG_BASE64 } from './fixtures.mjs';
import { migrateSettings, providerConnection } from '../providers.js';

const token = 'mcp-test-secret-0000000000000000000000';
const schema = { type: 'object', properties: { prompt: { type: 'string' } }, required: ['prompt'] };
const tool = { name: 'anima_validate_prompt', inputSchema: schema };
const settings = { ...MCP_DEFAULTS, mcpPromptTools: [tool.name], mcpReadSkill: false, promptConnectionMode: 'manual' };
const reply = (content, calls = [], reason = calls.length ? 'tool_calls' : 'stop') => ({ choices: [{ finish_reason: reason, message: { content, ...(calls.length ? { tool_calls: calls } : {}) } }] });
const call = (name = tool.name, args = { prompt: 'safe, landscape' }, id = 'call_1') => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const imageResult = () => ({ structuredContent: { seed: '18446744073709551613' }, content: [{ type: 'image', mimeType: 'image/png', data: PNG_BASE64 }] });
function fixtureClient(override) {
    const calls = [];
    const client = createMcpClient({ url: 'https://mcp.example/mcp', token, fetchImpl: async (url, init) => {
        const packet = JSON.parse(init.body); calls.push({ url, init, packet });
        if (override) { const result = await override(packet, init); if (result) return result; }
        if (packet.method === 'notifications/initialized') return new Response(null, { status: 202 });
        const result = packet.method === 'initialize' ? { protocolVersion: MCP_VERSION, capabilities: { tools: {} }, serverInfo: { name: 'anima-comfyui-browser' } }
            : packet.method === 'tools/list' ? { tools: [tool] } : { content: [{ type: 'text', text: 'ok' }] };
        return Response.json({ jsonrpc: '2.0', id: packet.id, result }, { headers: { 'Mcp-Session-Id': 'fixture-session' } });
    } });
    return { client, calls };
}

test('MCP handshake, session headers and credentials stay inside the selected endpoint', async () => {
    const { client, calls } = fixtureClient();
    assert.deepEqual(await client.listTools(), [tool]);
    await client.callTool(tool.name, { prompt: 'safe' });
    assert.deepEqual(calls.map(item => item.packet.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    for (const { init } of calls) {
        assert.equal(init.credentials, 'omit'); assert.equal(init.redirect, 'error');
        assert.equal(init.headers.Authorization, `Bearer ${token}`); assert.equal(init.headers.Cookie, undefined);
        assert.equal(init.headers['X-CSRF-Token'], undefined);
    }
    assert.equal(calls[2].init.headers['MCP-Protocol-Version'], MCP_VERSION);
    assert.equal(calls[2].init.headers['Mcp-Session-Id'], 'fixture-session');
});

test('MCP rejects insecure URLs, bad tokens, wrong server and incorrect response IDs', async () => {
    for (const url of ['http://remote.example/mcp', 'https://u:p@example/mcp', 'file:///etc/passwd', 'https://example/mcp?token=x']) assert.throws(() => mcpUrl(url));
    assert.throws(() => createMcpClient({ url: 'https://example/mcp', token: 'bad' }));
    const { client } = fixtureClient(packet => Response.json({ jsonrpc: '2.0', id: packet.id + 1, result: {} }));
    await assert.rejects(client.connect(), /ID/);
    const wrong = fixtureClient(packet => Response.json({ jsonrpc: '2.0', id: packet.id, result: { protocolVersion: MCP_VERSION, serverInfo: { name: 'other' }, capabilities: { tools: {} } } }));
    await assert.rejects(wrong.client.connect(), /browser_server/);
});

test('MCP tool calls are not retried; upstream bodies and tokens are not echoed', async () => {
    const { client, calls } = fixtureClient(packet => packet.method === 'tools/call' ? new Response(`secret ${token}`, { status: 500 }) : null);
    await assert.rejects(client.callTool('comfyui_generate', {}), error => !error.message.includes(token) && /500/.test(error.message));
    assert.equal(calls.filter(item => item.packet.method === 'tools/call').length, 1);
});

test('MCP supports bounded SSE results and rejects oversized responses', async () => {
    const { client } = fixtureClient(packet => packet.method === 'tools/list' ? new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: packet.id, result: { tools: [tool] } })}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } }) : null);
    assert.deepEqual(await client.listTools(), [tool]);
    const large = fixtureClient(packet => packet.method === 'tools/call' ? new Response('x'.repeat(40), { headers: { 'Content-Type': 'application/json' } }) : null);
    await assert.rejects(large.client.callTool(tool.name, {}, undefined, { maxBytes: 20 }));
});

test('MCP pre-abort performs no network request', async () => {
    const { client, calls } = fixtureClient(); const controller = new AbortController(); controller.abort();
    await assert.rejects(client.connect(controller.signal)); assert.equal(calls.length, 0);
});

test('MCP payload preserves 64-bit seeds and rejects excessive or unsafe image parameters', () => {
    const payload = buildMcpPayload('safe, landscape', { ...settings, mcpSeed: '18446744073709551613' });
    assert.equal(payload.seed, '18446744073709551613'); assert.equal(payload.dry_run, undefined);
    assert.throws(() => buildMcpPayload('safe', { ...settings, mcpSeed: '18446744073709551616' }));
    assert.throws(() => buildMcpPayload('safe', { ...settings, mcpWidth: '65' }));
    assert.throws(() => buildMcpPayload('safe', { ...settings, mcpBatchSize: '5' }));
    assert.throws(() => buildMcpPayload('safe', { ...settings, mcpWidth: '2048', mcpHeight: '2048', mcpBatchSize: '2' }));
    assert.deepEqual(providerConnection({ provider: 'anima-mcp' }), { provider: 'anima-mcp' });
    assert.equal(migrateSettings({ sillytavern_custom_text2img: { provider: 'anima-mcp' } }, settings).settings.provider, 'anima-mcp');
});

test('tool loop roundtrips tool messages, preserves reasoning and never mutates input', async () => {
    const messages = [{ role: 'user', content: 'plan scene JSON' }], seen = [], invoked = [];
    const mcp = { listTools: async () => [tool], callTool: async (name, args) => { invoked.push({ name, args }); return { structuredContent: { valid: true } }; } };
    const sendTurn = async (history, tools) => {
        seen.push(structuredClone(history)); assert.equal(tools[0].function.name, tool.name);
        if (seen.length === 1) { const raw = reply(null, [call()]); raw.choices[0].message.reasoning_content = 'reason'; return raw; }
        assert.equal(history.at(-2).reasoning_content, 'reason');
        assert.deepEqual(history.at(-1), { role: 'tool', tool_call_id: 'call_1', content: '{"valid":true}' });
        return reply('{"scenes":[]}');
    };
    assert.equal(await runMcpPromptLoop({ settings, messages, mcp, sendTurn }), '{"scenes":[]}');
    assert.equal(invoked.length, 1); assert.equal(messages.length, 1);
});

for (const [label, invalid] of [['paid tool', call('comfyui_generate')], ['unknown', call('run_shell')], ['bad args', call(tool.name, { prompt: 'safe', output_dir: '/tmp' })], ['missing arg', call(tool.name, {})], ['array arg', call(tool.name, [])], ['duplicate id', call()]]) {
    test(`tool loop validates whole batch before execution: ${label}`, async () => {
        let invoked = 0;
        const bad = structuredClone(invalid); if (label !== 'duplicate id') bad.id = 'call_2';
        await assert.rejects(runMcpPromptLoop({ settings, messages: [], mcp: { listTools: async () => [tool], callTool: async () => { invoked++; } }, sendTurn: async () => reply(null, [call(), bad]) }));
        assert.equal(invoked, 0);
    });
}

test('tool loop rejects truncation, unsupported envelopes and excessive rounds', async () => {
    assert.throws(() => decodeToolTurn(reply('partial', [], 'length')));
    assert.throws(() => decodeToolTurn({ content: [{ type: 'tool_use' }], choices: [{ message: { content: '' } }] }));
    let turns = 0, invoked = 0;
    await assert.rejects(runMcpPromptLoop({ settings: { ...settings, mcpMaxRounds: 1 }, messages: [],
        mcp: { listTools: async () => [tool], callTool: async () => { invoked++; return { structuredContent: { ok: true } }; } },
        sendTurn: async () => reply(null, [call(tool.name, { prompt: 'safe' }, `call_${++turns}`)]) }), /上限/);
    assert.equal(invoked, 1);
});

test('manual raw tool mode preserves existing authentication and sends isolated tools', async () => {
    let body;
    const manualLlm = createManualLlmClient({ fetchImpl: async (_url, init) => { body = JSON.parse(init.body); return Response.json(reply(null, [call()])); } });
    const config = { ...settings, manualLlmBaseUrl: 'https://llm.example/v1', manualLlmModel: 'fixture', manualLlmApiKey: 'fake-llm-key' };
    const raw = await sendMcpTurn({ settings: config, manualLlm, messages: [], maxTokens: 500, tools: [tool] });
    assert.equal(raw.choices[0].message.tool_calls[0].id, 'call_1');
    assert.equal(body.tools[0].name, tool.name); assert.equal(body.n, 1); assert.equal(body.stream, false);
    assert.ok(!JSON.stringify(body).includes(token));
});

test('CM tool transport requires explicit opt-in and rejects destructive postprocessing', async () => {
    let received;
    const context = { CONNECT_API_MAP: { custom: { selected: 'openai', source: 'custom' } }, extensionSettings: { connectionManager: { profiles: [{ id: 'p', api: 'custom' }] } },
        ConnectionManagerRequestService: { sendRequest: async (...args) => { received = args; return reply('ok'); } } };
    const config = { ...settings, promptConnectionMode: 'profile', profileId: 'p' };
    assert.throws(() => assertMcpLlmSupport(config, context), /安全工具傳輸/);
    await sendMcpTurn({ settings: { ...config, mcpProfileTransport: true }, context, messages: [], maxTokens: 50, tools: [tool] });
    assert.equal(received[3].includePreset, false); assert.equal(received[3].extractData, false); assert.equal(received[4].custom_include_body, '');
    context.extensionSettings.connectionManager.profiles[0]['prompt-post-processing'] = 'merge';
    assert.throws(() => assertMcpLlmSupport({ ...config, mcpProfileTransport: true }, context), /後處理/);
});

test('known incompatible OpenAI models and live CM profile changes fail before sending', async () => {
    for (const model of ['gpt-5-chat-latest', 'o1-preview', 'o3', 'o4-mini', 'openai/o3', 'openai/gpt-5']) assert.throws(() => assertMcpLlmSupport({ ...settings, manualLlmModel: model }, {}), /專用/);
    let sends = 0;
    const profile = { id: 'p', api: 'openai', model: 'gpt-4.1', 'api-url': 'https://first.example' };
    const context = { CONNECT_API_MAP: { openai: { selected: 'openai', source: 'openai' } }, extensionSettings: { connectionManager: { profiles: [profile] } },
        ConnectionManagerRequestService: { sendRequest: async () => { sends++; return reply('ok'); } } };
    const config = { ...settings, promptConnectionMode: 'profile', profileId: 'p', mcpProfileTransport: true };
    const expectedProfile = profileFingerprint(config, context);
    profile['api-url'] = 'https://changed.example';
    await assert.rejects(sendMcpTurn({ settings: config, context, expectedProfile, tools: [tool], messages: [] }), /已變更/);
    assert.equal(sends, 0);
    profile.proxy = 'shared-proxy';
    const proxies = [{ name: 'shared-proxy', url: 'https://proxy-a.example', password: 'test' }];
    const pinnedProxy = profileFingerprint(config, context, proxies);
    proxies[0].url = 'https://proxy-b.example';
    await assert.rejects(sendMcpTurn({ settings: config, context, expectedProfile: pinnedProxy, proxyPresets: proxies, tools: [tool], messages: [] }), /已變更/);
    assert.equal(sends, 0);
    for (const model of ['openai/o3', 'openai/gpt-5']) { profile.model = model; assert.throws(() => assertMcpLlmSupport(config, context), /專用/); }
});

test('MCP images are embedded, bounded, typed and seed-safe', () => {
    assert.equal(decodeMcpImages(imageResult(), 1)[0].seed, '18446744073709551613');
    assert.throws(() => decodeMcpImages({ content: [{ type: 'text', text: '/etc/passwd' }] }, 1));
    assert.throws(() => decodeMcpImages({ ...imageResult(), structuredContent: { seed: 18446744073709551613 } }, 1));
    const mismatch = imageResult(); mismatch.content[0].mimeType = 'image/svg+xml'; assert.throws(() => decodeMcpImages(mismatch, 1));
});

test('stopping image polling never resubmits, frees the running lock early, or changes ownership', async () => {
    const images = createMcpImages(); let resolve, count = 0;
    const mcp = { callTool: async () => { count++; return new Promise(done => { resolve = done; }); } };
    const client = images.client(mcp), other = images.client(mcp);
    const snapshot = await client.submit({ batch_size: 1 });
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.poll(snapshot.job_id, 0, controller.signal));
    await assert.rejects(other.submit({ batch_size: 1 }), /已有/);
    assert.equal(count, 1); assert.equal(images.busy, true);
    resolve(imageResult()); await images.settled();
    const done = await client.poll(snapshot.job_id, 0); assert.equal(done.finished, true); assert.equal(images.busy, false);
    const file = done.events.at(-1).images[0]; assert.equal((await client.output(file)).data, PNG_BASE64);
    await assert.rejects(other.output(file), /不屬於/);
});
