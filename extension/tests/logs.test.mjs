import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogStore, createLogRedactor, logSecrets, formatLogEntry } from '../logs.js';
import { PNG_BASE64 } from './fixtures.mjs';

const exportLog = store => store.getEntries().map(formatLogEntry).join('\n');

test('page-local log defaults to summary, snapshots data and gates details at write time', () => {
    let now = 1700000000000;
    const store = createLogStore({ now: () => now });
    const run = store.startRun({ provider: 'novelai', messageId: 0 });
    run.add('start', 'started');
    run.detail('llm', 'private', { content: 'private prompt' });
    assert.equal(store.getEntries().length, 1);
    assert.equal(store.detailed, false);
    store.setDetailed(true);
    const body = { content: 'visible prompt' };
    now += 1200;
    run.detail('llm', 'response', body); body.content = 'changed later';
    assert.match(exportLog(store), /visible prompt/);
    assert.doesNotMatch(exportLog(store), /changed later|private prompt/);
    assert.equal(store.getEntries()[1].elapsedMs, 1200);
    assert.match(exportLog(store), /樓層 0.*\+1.20s/);
    store.setDetailed(false);
    run.detail('llm', 'hidden again', { content: 'not recorded' });
    assert.doesNotMatch(exportLog(store), /not recorded/);
    assert.match(exportLog(store), /visible prompt/);
    assert.equal(createLogStore().getEntries().length, 0);
    assert.equal(createLogStore().detailed, false);
});

test('redacts known credentials including custom header values, nested keys, URLs and encoded echoes', () => {
    const settings = { password: 'my panel password', manualLlmApiKey: 'custom/secret+key', manualLlmExtraHeaders: '{"X-Custom":"opaque-value"}' };
    const redact = createLogRedactor(logSecrets(settings, 'novel-token-value'));
    const result = JSON.stringify(redact.sanitize({
        password: 'password-hidden', arbitrary: ['my panel password', 'custom/secret+key', 'opaque-value', 'novel-token-value', encodeURIComponent('custom/secret+key')],
        nested: { Authorization: 'anything', headers: { 'X-Unknown': 'hidden-header' }, api_key: 'hidden-key' },
        message: 'Bearer unregistered-bearer https://user:pass@example.com/job?other=hidden-query#hidden-fragment token=unknown-token sk-unknownkey',
        max_tokens: 400,
    }));
    assert.doesNotMatch(result, /my panel password|custom\/secret|opaque-value|novel-token-value|password-hidden|hidden-header|hidden-key|unregistered-bearer|unknown-token|sk-unknownkey|user:pass|hidden-query|hidden-fragment/);
    assert.match(result, /REDACTED/); assert.match(result, /max_tokens":400/);
});

test('does not retain binary image data; handles circular input and bounds encoded strings', () => {
    const store = createLogStore(); store.setDetailed(true);
    const run = store.startRun();
    const data = { image: 'not-a-log', data: 'base64-bytes', bytes: [1, 2], binary: new Uint8Array([3, 4]), text: `data:image/png;base64,${'A'.repeat(500)}` };
    data.circular = data;
    data.preview = PNG_BASE64;
    run.detail('result', 'output', data);
    assert.doesNotMatch(exportLog(store), /not-a-log|base64-bytes|AAAA/);
    assert.match(exportLog(store), /binary omitted|image omitted/);
    assert.ok(!exportLog(store).includes(PNG_BASE64));
});

test('third-party credential containers and token variants are masked while numeric token counts remain', () => {
    const redact = createLogRedactor();
    const result = JSON.stringify(redact.sanitize({ panel_values: { api_token: 'third-party-secret', apiToken: 'camel-secret',
        auth_token: 'auth-secret', session_token: 'session-secret', credentials: { id: 'hidden-id' }, max_tokens: 400 } }));
    assert.doesNotMatch(result, /third-party-secret|camel-secret|auth-secret|session-secret|hidden-id/);
    assert.match(result, /max_tokens":400/);
});

test('errors include the actual message, HTTP status and stack without detailed mode, in one redacted entry', () => {
    const store = createLogStore(), run = store.startRun({}, ['known-secret']);
    const error = Object.assign(new Error('upstream rejected parameter width; echoed PRIVATE_CHAT known-secret'), { status: 422 });
    run.error('generation', error);
    assert.equal(store.detailed, false);
    assert.equal(store.getEntries().length, 1);
    assert.equal(store.getEntries()[0].level, 'error');
    assert.match(exportLog(store), /upstream rejected parameter width/);
    assert.match(exportLog(store), /HTTP 422/);
    assert.match(exportLog(store), /PRIVATE_CHAT/);
    assert.match(JSON.parse(store.getEntries()[0].data).stack, /at TestContext/);
    assert.doesNotMatch(exportLog(store), /known-secret|原始錯誤僅在詳細模式|原始錯誤（詳細模式）/);
    store.setDetailed(true); run.error('generation', error);
    assert.equal(store.getEntries().length, 2, 'Detailed mode must not duplicate the error as DEBUG');
    assert.doesNotMatch(exportLog(store), /known-secret/);
});

test('local and string errors stay useful without HTTP status or an empty metadata object', () => {
    const store = createLogStore(), run = store.startRun();
    run.error('analysis', new Error('獨立預設 prepare 失敗：正則語法無效'));
    run.error('analysis', 'Worker unavailable');
    run.error('analysis', undefined);
    assert.match(exportLog(store), /正則語法無效/);
    assert.match(exportLog(store), /Worker unavailable/);
    assert.match(exportLog(store), /未知錯誤/);
    assert.doesNotMatch(exportLog(store), /HTTP|\n\{\}/);
    assert.ok(store.getEntries().every(entry => JSON.parse(entry.data).message));
});

test('error causes and codes survive logging without exposing credentials or binary data', () => {
    const store = createLogStore(), run = store.startRun({}, ['known-secret']);
    const cause = Object.assign(new Error('connect failed known-secret Bearer hidden-token'), { code: 'ECONNRESET' });
    const error = Object.assign(new Error(`request failed data:image/png;base64,${PNG_BASE64}`, { cause }), { code: 'FETCH_FAILED' });
    run.error('llm', error);
    const data = JSON.parse(store.getEntries()[0].data);
    assert.equal(data.code, 'FETCH_FAILED');
    assert.equal(data.cause.code, 'ECONNRESET');
    assert.match(data.cause.message, /connect failed/);
    assert.doesNotMatch(exportLog(store), /known-secret|hidden-token/);
    assert.ok(!exportLog(store).includes(PNG_BASE64));
});

test('ring buffer has entry and character limits and clear keeps live run usable', () => {
    const store = createLogStore({ maxEntries: 3, maxChars: 1800, maxEntryChars: 600 });
    const run = store.startRun();
    for (let i = 0; i < 10; i++) run.add('event', `event-${i}`, { data: { content: 'words '.repeat(300) } });
    assert.ok(store.stats().count <= 3);
    assert.ok(store.stats().chars <= 1800);
    assert.ok(store.stats().dropped >= 7);
    assert.match(exportLog(store), /truncated/);
    assert.doesNotMatch(exportLog(store), /event-0/);
    store.clear(); assert.equal(store.getEntries().length, 0); assert.equal(store.stats().dropped, 0);
    run.add('complete', 'finished after clear'); assert.match(exportLog(store), /finished after clear/);
});

test('independent run IDs, safe errors, subscriber exceptions never affect jobs', () => {
    const store = createLogStore();
    let notifications = 0;
    const off = store.subscribe(() => notifications++);
    store.subscribe(() => { throw new Error('broken view'); });
    const a = store.startRun({ provider: 'novelai' }, ['my-secret']);
    const b = store.startRun({ provider: 'comfy-modal' });
    a.error('llm', Object.assign(new Error('failed my-secret'), { status: 401 }));
    b.add('complete', 'ok');
    assert.notEqual(a.id, b.id); assert.equal(notifications, 2);
    assert.doesNotMatch(exportLog(store), /my-secret/);
    assert.match(exportLog(store), /at TestContext/);
    assert.match(exportLog(store), /401/);
    off(); store.clear(); assert.equal(notifications, 2);
});
