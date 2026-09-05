/** Browser-only transport primitives. Never attach ST cookies or CSRF headers to an external API. */
export class HttpError extends Error {
    constructor(status, message) { super(message); this.name = 'HttpError'; this.status = status; }
}

export function withTimeout(signal, milliseconds) {
    const timeout = AbortSignal.timeout(milliseconds);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Bound decoded bytes, not merely the untrusted Content-Length. Always release/cancel the reader. */
export async function readStreamLimited(stream, limit, signal) {
    if (!stream) throw new HttpError(502, '伺服器回應為空。');
    const reader = stream.getReader();
    const chunks = [];
    let size = 0, finished = false;
    const onAbort = () => { void reader.cancel(signal.reason).catch(() => {}); };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
        while (true) {
            signal?.throwIfAborted();
            const { value, done } = await reader.read();
            signal?.throwIfAborted();
            if (done) { finished = true; break; }
            size += value.byteLength;
            if (size > limit) throw new HttpError(502, '伺服器回應超過大小限制。');
            chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
        return bytes;
    } finally {
        signal?.removeEventListener('abort', onAbort);
        if (!finished) await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

export async function readLimited(response, limit, signal) {
    if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel().catch(() => {});
        throw new HttpError(502, '伺服器回應超過大小限制。');
    }
    return readStreamLimited(response.body, limit, signal);
}

export async function readJson(response, signal, limit = 4 * 1024 * 1024) {
    const bytes = await readLimited(response, limit, signal);
    try { return JSON.parse(new TextDecoder().decode(bytes)); }
    catch { throw new HttpError(502, '伺服器未回傳有效 JSON；請確認填的是控制面板網址，而非登入攔截頁。'); }
}

export function bytesToBase64(bytes) {
    const parts = [];
    for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        parts.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
    }
    return btoa(parts.join(''));
}

export function base64ToBytes(text) {
    const decoded = atob(text);
    return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

export function normalizeToken(value) {
    const token = typeof value === 'string' ? value.trim() : '';
    if (!/^[\x21-\x7e]{1,4096}$/.test(token)) {
        throw new HttpError(400, '請先輸入有效的 NovelAI Persistent API Token（不含 Bearer 前綴）。');
    }
    return token;
}
