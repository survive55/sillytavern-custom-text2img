/**
 * SillyTavern server plugin: sillytavern-custom-text2img
 *
 * Unified backend for the bundled UI in extension/. NovelAI official API,
 * per-user secrets, bounded jobs and image decoding live in server/novelai.js.
 * The existing ComfyUI provider below is a same-origin proxy to the web control
 * panel (`ui_server.py`, localhost or an HTTPS Quick Tunnel URL). The browser-side
 * extension cannot call that panel directly (different origin, cookie-based
 * login), so every request goes through here:
 *
 *   POST /api/plugins/sillytavern-custom-text2img/test      -> login + /api/queue
 *   POST /api/plugins/sillytavern-custom-text2img/presets   -> GET  {base}/api/presets
 *   POST /api/plugins/sillytavern-custom-text2img/preset    -> GET  {base}/api/presets/{name}
 *   POST /api/plugins/sillytavern-custom-text2img/schema    -> GET  {base}/api/schema
 *   POST /api/plugins/sillytavern-custom-text2img/jobs      -> POST {base}/api/generate/jobs (202 JSON)
 *   POST /api/plugins/sillytavern-custom-text2img/job       -> GET  {base}/api/generate/jobs/{id}?after=N
 *   POST /api/plugins/sillytavern-custom-text2img/generate  -> legacy SSE pass-through (not tunnel-safe)
 *   POST /api/plugins/sillytavern-custom-text2img/output    -> GET  {base}/api/output/{path} (as base64 JSON)
 *   GET  /api/plugins/sillytavern-custom-text2img/probe     -> liveness check for the UI extension
 *
 * The panel is never modified: the plugin only reads presets/schema and calls the
 * existing generate endpoint, so the workflow / preset structure stays intact.
 *
 * Every request body carries `baseUrl` and `password`; the plugin logs in on
 * demand, caches the session cookie per (baseUrl, password) and transparently
 * re-logs in once when the panel answers 401.
 */

const { Readable } = require('node:stream');
const crypto = require('node:crypto');

const PLUGIN_ID = 'sillytavern-custom-text2img';
const PLUGIN_VERSION = require('./package.json').version;
const SESSION_COOKIE = 'comfyui_ui_session';
const LOGIN_TIMEOUT_MS = 15_000;
const JSON_TIMEOUT_MS = 60_000;
const OUTPUT_TIMEOUT_MS = 120_000;

/** @type {Map<string, string>} cache key -> cookie header value */
const sessions = new Map();

/**
 * Normalize and validate the panel base URL.
 * @param {unknown} raw
 * @returns {string}
 */
function normalizeBaseUrl(raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
        throw new HttpError(400, 'baseUrl is required');
    }
    let url;
    try {
        url = new URL(text);
    } catch {
        throw new HttpError(400, `baseUrl is not a valid URL: ${text}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new HttpError(400, 'baseUrl must use http or https');
    }
    if (url.username || url.password || url.search || url.hash) {
        throw new HttpError(400, 'baseUrl must be the panel URL without credentials, query, or fragment');
    }
    return url.toString().replace(/\/+$/, '');
}

const { HttpError, route } = require('./server/http.js');
const { createNovelAI } = require('./server/novelai.js');
const novelai = createNovelAI();

/**
 * @param {string} baseUrl
 * @param {string} password
 */
function sessionKey(baseUrl, password) {
    return crypto.createHash('sha256').update(`${baseUrl}\n${password}`).digest('hex');
}

/**
 * Fetch with a deadline and optional caller cancellation; 0 disables the deadline.
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [externalSignal]
 */
async function fetchWithTimeout(url, init, timeoutMs, externalSignal = null) {
    // Keep the deadline alive while the caller reads JSON/image bytes, not
    // merely until fetch receives headers. Long legacy SSE has timeoutMs=0.
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : null;
    const signal = externalSignal && timeout
        ? AbortSignal.any([externalSignal, timeout])
        : (externalSignal || timeout);
    return fetch(url, { ...init, signal });
}

/**
 * Log in to the panel and return the cookie header value.
 * @param {string} baseUrl
 * @param {string} password
 * @returns {Promise<string>}
 */
async function login(baseUrl, password) {
    let response;
    try {
        response = await fetchWithTimeout(`${baseUrl}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: String(password ?? '') }),
        }, LOGIN_TIMEOUT_MS);
    } catch (error) {
        throw new HttpError(502, `Could not reach the image server at ${baseUrl}: ${error?.cause?.message || error.message}`);
    }
    if (response.status === 401) {
        throw new HttpError(401, 'The image server rejected the password');
    }
    if (!response.ok) {
        throw new HttpError(502, `Image server login failed with HTTP ${response.status}`);
    }
    const setCookie = typeof response.headers.getSetCookie === 'function'
        ? response.headers.getSetCookie()
        : [response.headers.get('set-cookie')].filter(Boolean);
    const sessionCookie = setCookie
        .map((line) => line.split(';')[0].trim())
        .find((pair) => pair.startsWith(`${SESSION_COOKIE}=`));
    if (!sessionCookie) {
        throw new HttpError(502, 'Image server login did not return a session cookie');
    }
    const key = sessionKey(baseUrl, password);
    sessions.set(key, sessionCookie);
    return sessionCookie;
}

/**
 * Perform an authenticated request against the panel, logging in first and
 * retrying once after a 401.
 * @param {string} baseUrl
 * @param {string} password
 * @param {string} path
 * @param {RequestInit} init
 * @param {number} timeoutMs
 * @param {AbortSignal | null} [signal]
 * @returns {Promise<Response>}
 */
async function authedFetch(baseUrl, password, path, init, timeoutMs, signal = null) {
    const key = sessionKey(baseUrl, password);
    let cookie = sessions.get(key) || await login(baseUrl, password);
    const doFetch = async () => {
        try {
            return await fetchWithTimeout(`${baseUrl}${path}`, {
                ...init,
                headers: { ...(init.headers || {}), Cookie: cookie },
            }, timeoutMs, signal);
        } catch (error) {
            if (signal?.aborted) throw error;
            throw new HttpError(502, `Image server request failed: ${error?.cause?.message || error.message}`);
        }
    };
    let response = await doFetch();
    if (response.status === 401) {
        sessions.delete(key);
        cookie = await login(baseUrl, password);
        response = await doFetch();
    }
    return response;
}

/**
 * Extract the {baseUrl, password} pair from a request body.
 * @param {import('express').Request} req
 */
function credentialsFrom(req) {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    return {
        baseUrl: normalizeBaseUrl(body.baseUrl),
        password: String(body.password ?? ''),
        body,
    };
}

/**
 * Translate an upstream non-OK JSON response into an HttpError.
 * @param {Response} response
 */
async function upstreamError(response) {
    const text = await response.text().catch(() => '');
    let detail = text;
    try {
        const data = JSON.parse(text);
        detail = data?.detail ? (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) : JSON.stringify(data);
    } catch { /* Cloudflare errors may be plain text/HTML rather than JSON. */ }
    const status = [400, 401, 403, 404, 409, 413, 422, 429].includes(response.status) ? response.status : 502;
    return new HttpError(status, `Image server answered HTTP ${response.status}${detail ? `: ${detail.slice(0, 2000)}` : ''}`);
}

/**
 * @param {import('express').Router} router
 */
async function init(router) {
    router.use((_req, res, next) => {
        res.setHeader('Cache-Control', 'private, no-store, no-transform');
        next();
    });
    router.get('/probe', (_req, res) => {
        res.json({ ok: true, id: PLUGIN_ID, version: PLUGIN_VERSION, providers: ['comfy-modal', 'novelai'], generation_transports: ['poll', 'sse'] });
    });

    router.post('/test', route(async (req, res) => {
        const { baseUrl, password } = credentialsFrom(req);
        const key = sessionKey(baseUrl, password);
        sessions.delete(key);
        await login(baseUrl, password);
        const response = await authedFetch(baseUrl, password, '/api/queue', { method: 'GET' }, JSON_TIMEOUT_MS);
        if (!response.ok) throw await upstreamError(response);
        const queue = await response.json();
        const polling = queue?.generation_transports?.includes('poll') === true;
        res.json({
            ok: true, baseUrl, waiting: queue?.waiting ?? 0,
            generation_transport: polling ? 'poll' : 'sse',
            warning: polling ? null : 'Image server needs the generation-jobs update for Cloudflare Quick Tunnel support',
        });
    }));

    router.post('/presets', route(async (req, res) => {
        const { baseUrl, password } = credentialsFrom(req);
        const response = await authedFetch(baseUrl, password, '/api/presets', { method: 'GET' }, JSON_TIMEOUT_MS);
        if (!response.ok) throw await upstreamError(response);
        res.json(await response.json());
    }));

    router.post('/preset', route(async (req, res) => {
        const { baseUrl, password, body } = credentialsFrom(req);
        const name = String(body.name ?? '').trim();
        if (!name) throw new HttpError(400, 'name is required');
        const response = await authedFetch(baseUrl, password, `/api/presets/${encodeURIComponent(name)}`, { method: 'GET' }, JSON_TIMEOUT_MS);
        if (response.status === 404) throw new HttpError(404, `No such preset on the image server: ${name}`);
        if (!response.ok) throw await upstreamError(response);
        res.json(await response.json());
    }));

    router.post('/schema', route(async (req, res) => {
        const { baseUrl, password, body } = credentialsFrom(req);
        const refresh = body.refresh ? '?refresh=true' : '';
        const response = await authedFetch(baseUrl, password, `/api/schema${refresh}`, { method: 'GET' }, JSON_TIMEOUT_MS);
        if (!response.ok) throw await upstreamError(response);
        res.json(await response.json());
    }));

    router.post('/jobs', route(async (req, res) => {
        const { baseUrl, password, body } = credentialsFrom(req);
        const payload = body.payload;
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)
            || !String(payload.prompt_text ?? '').trim()) {
            throw new HttpError(400, 'payload.prompt_text is required');
        }
        // Submit exactly once. Never retry transport errors: the server may
        // have accepted a paid GPU job even when its response was lost.
        const response = await authedFetch(baseUrl, password, '/api/generate/jobs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(payload),
        }, JSON_TIMEOUT_MS);
        if (response.status === 404 || response.status === 405) {
            throw new HttpError(409, '請更新並重新載入圖片伺服器 ui_server.py；它尚未提供 Quick Tunnel 所需的生圖任務 API。');
        }
        if (!response.ok) throw await upstreamError(response);
        res.status(202).json(await response.json());
    }));

    router.post('/job', route(async (req, res) => {
        const { baseUrl, password, body } = credentialsFrom(req);
        const jobId = String(body.jobId ?? '');
        const after = body.after ?? 0;
        if (!/^[a-f0-9]{32}$/.test(jobId)) throw new HttpError(400, 'jobId is invalid');
        if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(400, 'after must be a non-negative integer');
        const response = await authedFetch(baseUrl, password,
            `/api/generate/jobs/${jobId}?after=${after}`, { method: 'GET' }, JSON_TIMEOUT_MS);
        if (!response.ok) throw await upstreamError(response);
        res.json(await response.json());
    }));

    router.post('/generate', route(async (req, res) => {
        const { baseUrl, password, body } = credentialsFrom(req);
        const payload = body.payload && typeof body.payload === 'object' ? body.payload : {};
        if (!String(payload.prompt_text ?? '').trim()) {
            throw new HttpError(400, 'payload.prompt_text is required');
        }

        // Abort the upstream generation when the browser goes away. Listen on the
        // *response*: since Node 16 `req` emits 'close' as soon as its body has
        // been consumed (which body-parser already did), not on disconnect.
        const controller = new AbortController();
        res.on('close', () => {
            if (!res.writableFinished) {
                console.log(`[${PLUGIN_ID}] client disconnected; aborting upstream generation`);
                controller.abort(new Error('Client disconnected'));
            }
        });

        const response = await authedFetch(baseUrl, password, '/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify(payload),
        }, 0, controller.signal);

        if (!response.ok) throw await upstreamError(response);
        if (!response.body) throw new HttpError(502, 'Image server returned an empty stream');

        res.status(200);
        res.setHeader('Content-Type', 'text/event-stream');
        // `no-transform` keeps ST's compression middleware from buffering the stream.
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        const upstream = Readable.fromWeb(/** @type {any} */ (response.body));
        upstream.on('error', (error) => {
            if (!controller.signal.aborted) {
                try {
                    res.write(`data: ${JSON.stringify({ type: 'error', message: `Stream interrupted: ${error.message}` })}\n\n`);
                } catch { /* ignore */ }
            }
            res.end();
        });
        upstream.pipe(res);
    }));

    router.post('/output', route(async (req, res) => {
        const { baseUrl, password, body } = credentialsFrom(req);
        const relPath = String(body.path ?? '').trim();
        if (!relPath || relPath.includes('..') || relPath.startsWith('/')) {
            throw new HttpError(400, 'path is invalid');
        }
        const encoded = relPath.split('/').map(encodeURIComponent).join('/');
        const response = await authedFetch(baseUrl, password, `/api/output/${encoded}`, { method: 'GET' }, OUTPUT_TIMEOUT_MS);
        if (response.status === 404) throw new HttpError(404, `Image not found on the image server: ${relPath}`);
        if (!response.ok) throw await upstreamError(response);
        const buffer = Buffer.from(await response.arrayBuffer());
        const mime = response.headers.get('content-type') || 'image/png';
        const ext = relPath.split('.').pop()?.toLowerCase() || '';
        const format = ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext) ? (ext === 'jpeg' ? 'jpg' : ext) : (mime.split('/')[1] || 'png');
        res.json({ format, mime, data: buffer.toString('base64'), bytes: buffer.length });
    }));

    novelai.mount(router);
    console.log(`[${PLUGIN_ID}] loaded (v${PLUGIN_VERSION}); ComfyUI/Modal + NovelAI under /api/plugins/${PLUGIN_ID}`);
}

async function exit() {
    sessions.clear();
    await novelai.close();
}

module.exports = {
    init,
    exit,
    info: {
        id: PLUGIN_ID,
        name: 'SillyTavern Custom Text2Img',
        description: 'Integrated message illustrations: ComfyUI on Modal panels and the official NovelAI image API.',
    },
};
