import { HttpError, bytesToBase64, readJson, readLimited, withTimeout } from './http.js';

export function normalizePanelUrl(raw) {
    let url;
    try { url = new URL(String(raw ?? '').trim()); }
    catch { throw new HttpError(400, '請填寫有效的控制面板 Base URL。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new HttpError(400, '面板網址必須是 HTTP(S)，不能包含帳密、查詢參數或 fragment。');
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new HttpError(400, '非本機面板請使用 HTTPS／Quick Tunnel，避免以明文傳送登入密碼。');
    }
    return url.href.replace(/\/+$/, '');
}

async function responseError(response, signal) {
    let detail = '';
    try {
        const data = await readJson(response, signal, 64 * 1024);
        if (typeof data?.detail === 'string') detail = data.detail;
    } catch { /* Never surface a tunnel's HTML page as an error message. */ }
    if (response.status === 404) {
        const explanation = !detail || detail === 'Not Found'
            ? '請更新控制面板，提供 /api/browser 安全直連 API；不需要安裝 ST 後端插件。' : detail;
        return new HttpError(404, `面板回傳 HTTP 404：${explanation}`);
    }
    if (response.status === 401) return new HttpError(401, '面板密碼錯誤或登入已過期；請重新測試連線。');
    return new HttpError(response.status, `面板 HTTP ${response.status}${detail ? `：${detail.slice(0, 2000)}` : ''}`);
}

function imageFormat(bytes) {
    if (bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte)) return ['png', 'image/png'];
    if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['jpg', 'image/jpeg'];
    const head = new TextDecoder().decode(bytes.subarray(0, 12));
    if (head.startsWith('GIF87a') || head.startsWith('GIF89a')) return ['gif', 'image/gif'];
    if (head.startsWith('RIFF') && head.endsWith('WEBP')) return ['webp', 'image/webp'];
    throw new HttpError(502, '面板未回傳 PNG／JPEG／WebP／GIF 圖片；請檢查網址或登入攔截頁。');
}

/** Immutable connection, with one in-memory, origin-bound token per client.
 * No cookies, ST headers, URL credentials, generic proxies or automatic POST retries.
 */
export function createPanelClient({ baseUrl, password }, { fetchImpl = (...args) => fetch(...args), now = Date.now } = {}) {
    const base = normalizePanelUrl(baseUrl);
    if (typeof password !== 'string' || !password || password.length > 4096) throw new HttpError(400, '請填寫控制面板的登入密碼。');
    let session = null, loginPromise = null;

    async function request(path, init, signal, timeout = 60000) {
        const deadline = withTimeout(signal, timeout);
        try {
            const response = await fetchImpl(`${base}/api/browser${path}`, { ...init, signal: deadline,
                mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', cache: 'no-store',
                headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
            return { response, deadline };
        } catch {
            deadline.throwIfAborted();
            throw new HttpError(502, '瀏覽器無法直連控制面板：請確認面板已更新、HTTPS／CORS 可用且網址可從目前裝置連線。127.0.0.1 指瀏覽器所在裝置，不是遠端 ST 伺服器。');
        }
    }

    async function login(signal) {
        const { response, deadline } = await request('/login', { method: 'POST', body: JSON.stringify({ password }) }, signal, 15000);
        if (!response.ok) throw await responseError(response, deadline);
        const data = await readJson(response, deadline, 32 * 1024);
        if (data?.protocol !== 1 || typeof data.token !== 'string' || !/^b1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(data.token)
            || !Number.isFinite(data.expires_at) || !data.generation_transports?.includes('poll')) {
            throw new HttpError(502, '面板尚未提供相容的瀏覽器任務 API，請更新面板服務。');
        }
        // expires_in avoids host/browser clock skew; cap token lifetime locally.
        const lifetime = Number.isFinite(data.expires_in) ? data.expires_in : data.expires_at - now() / 1000;
        session = { token: data.token, expiresAt: now() + Math.max(0, Math.min(3600, lifetime)) * 1000 };
    }

    async function prepare(signal) {
        signal?.throwIfAborted();
        if (session?.expiresAt > now() + 30000) return;
        if (!loginPromise) loginPromise = login(signal).finally(() => { loginPromise = null; });
        await loginPromise;
        signal?.throwIfAborted();
    }

    async function authorized(path, method = 'GET', body, signal, timeout) {
        await prepare(signal);
        const send = () => request(path, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            headers: { Authorization: `Bearer ${session.token}` } }, signal, timeout);
        let result = await send();
        // A read may reauthenticate once. A generation POST is never repeated.
        if (result.response.status === 401 && method === 'GET') {
            await result.response.body?.cancel().catch(() => {});
            session = null;
            await prepare(signal);
            result = await send();
        }
        if (!result.response.ok) throw await responseError(result.response, result.deadline);
        return result;
    }

    async function json(path, method, body, signal) {
        const { response, deadline } = await authorized(path, method, body, signal);
        return readJson(response, deadline);
    }

    return {
        prepare,
        async test(signal) {
            session = null;
            await prepare(signal);
            const queue = await json('/queue', 'GET', undefined, signal);
            if (!queue?.generation_transports?.includes('poll')) throw new HttpError(409, '面板不支援任務輪詢，請更新面板服務。');
            return { ok: true, baseUrl: base, generation_transport: 'poll', waiting: queue.waiting ?? 0 };
        },
        presets: signal => json('/presets', 'GET', undefined, signal),
        preset(name, signal) {
            if (typeof name !== 'string' || !name.trim()) throw new HttpError(400, '預設名稱不可空白。');
            return json(`/presets/${encodeURIComponent(name)}`, 'GET', undefined, signal);
        },
        schema: (refresh = false, signal) => json(`/schema${refresh ? '?refresh=true' : ''}`, 'GET', undefined, signal),
        submit(payload, signal) {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !String(payload.prompt_text ?? '').trim()) {
                throw new HttpError(400, 'ComfyUI prompt_text 不可空白。');
            }
            return json('/generate/jobs', 'POST', payload, signal);
        },
        poll(id, after, signal) {
            if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id) || !Number.isSafeInteger(after) || after < 0) throw new HttpError(400, '任務 ID 或游標無效。');
            return json(`/generate/jobs/${id}?after=${after}`, 'GET', undefined, signal);
        },
        async output(path, signal) {
            if (typeof path !== 'string' || !path || path.includes('\\') || path.split('/').some(part => ['', '.', '..'].includes(part))) {
                throw new HttpError(400, '圖片路徑無效。');
            }
            const encoded = path.split('/').map(encodeURIComponent).join('/');
            const { response, deadline } = await authorized(`/output/${encoded}`, 'GET', undefined, signal, 120000);
            const bytes = await readLimited(response, 128 * 1024 * 1024, deadline);
            const [format, mime] = imageFormat(bytes);
            return { format, mime, bytes: bytes.length, data: bytesToBase64(bytes) };
        },
    };
}
