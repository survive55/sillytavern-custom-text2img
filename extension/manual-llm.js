import { HttpError, readLimited } from './http.js';

const DEFAULT_PATH = 'chat/completions';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export class ManualLlmError extends Error {
    constructor(status, message) {
        super(message);
        this.name = 'ManualLlmError';
        this.status = status;
    }
}

function isLoopback(hostname) {
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}

export function buildManualLlmUrl(baseUrl, endpointPath = DEFAULT_PATH) {
    const rawBase = String(baseUrl ?? '').trim();
    if (!rawBase) throw new ManualLlmError(400, '請填寫手動 LLM Base URL。');
    let base;
    try {
        base = new URL(rawBase);
    } catch {
        throw new ManualLlmError(400, '手動 LLM Base URL 格式無效。');
    }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
        throw new ManualLlmError(400, '手動 LLM Base URL 不可包含帳密、查詢參數或片段。');
    }
    if (base.protocol !== 'https:' && !isLoopback(base.hostname)) {
        throw new ManualLlmError(400, '非本機的手動 LLM Base URL 必須使用 HTTPS，避免明文傳送 API Key。');
    }
    const path = String(endpointPath || DEFAULT_PATH).trim();
    if (/^[a-z][a-z\d+.-]*:/i.test(path) || path.includes('\\')) {
        throw new ManualLlmError(400, '自訂端點必須是相對於 Base URL 的路徑。');
    }
    const joinedPath = `${base.pathname.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
    base.pathname = joinedPath.replace(/\/{2,}/g, '/');
    return base.toString();
}

function isForbiddenRequestHeader(name) {
    const lower = name.toLowerCase();
    return ['accept-charset', 'accept-encoding', 'access-control-request-headers', 'access-control-request-method',
        'connection', 'content-length', 'content-type', 'cookie', 'cookie2', 'date', 'dnt', 'expect', 'host',
        'keep-alive', 'origin', 'referer', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'user-agent', 'via']
        .includes(lower) || lower.startsWith('proxy-') || lower.startsWith('sec-');
}

export function parseExtraHeaders(value) {
    const text = String(value ?? '').trim();
    if (!text) return {};
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ManualLlmError(400, '額外 Headers 必須是有效的 JSON 物件。');
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ManualLlmError(400, '額外 Headers 必須是 JSON 物件。');
    }
    const headers = {};
    for (const [name, rawValue] of Object.entries(parsed)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(String(rawValue))) {
            throw new ManualLlmError(400, `額外 Header 無效：${name}`);
        }
        if (isForbiddenRequestHeader(name)) {
            throw new ManualLlmError(400, `瀏覽器不允許自訂 Header：${name}`);
        }
        if (typeof rawValue !== 'string' && typeof rawValue !== 'number' && typeof rawValue !== 'boolean') {
            throw new ManualLlmError(400, `Header 值必須是字串、數字或布林值：${name}`);
        }
        headers[name] = String(rawValue);
    }
    return headers;
}

function extractContent(data) {
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content.map(part => typeof part === 'string' ? part : part?.text ?? '').join('');
    }
    if (typeof data?.choices?.[0]?.text === 'string') return data.choices[0].text;
    throw new ManualLlmError(502, '手動 LLM 回應缺少 choices[0].message.content。');
}

function safeError(status) {
    const messages = {
        400: '請檢查模型、提示詞或請求設定。',
        401: 'API Key 無效或驗證 Header 設定錯誤。',
        403: 'API Key 沒有使用此模型或端點的權限。',
        404: '找不到端點或模型，請檢查 Base URL、自訂路徑與模型名稱。',
        408: 'LLM 服務逾時。',
        413: '提示詞超過服務限制。',
        422: 'LLM 服務不接受目前的請求參數。',
        429: 'LLM 服務請求過於頻繁或額度不足。',
    };
    return `手動 LLM HTTP ${status}：${messages[status] || '服務暫時不可用。'}`;
}

export function createManualLlmClient({ fetchImpl = (...args) => fetch(...args), timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    async function send(settings, messages, maxTokens, signal) {
        if (signal?.aborted) throw new ManualLlmError(499, '手動 LLM 請求已取消。');
        const model = String(settings.manualLlmModel ?? '').trim();
        if (!model) throw new ManualLlmError(400, '請填寫手動 LLM 模型名稱。');
        const url = buildManualLlmUrl(settings.manualLlmBaseUrl, settings.manualLlmPath);
        const apiKey = String(settings.manualLlmApiKey ?? '').trim();
        const headerName = String(settings.manualLlmApiKeyHeader || 'Authorization').trim();
        const prefix = String(settings.manualLlmApiKeyPrefix ?? 'Bearer').trim();
        if (!apiKey) throw new ManualLlmError(400, '請填寫手動 LLM API Key。');
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(headerName)) throw new ManualLlmError(400, 'API Key Header 名稱無效。');
        if (isForbiddenRequestHeader(headerName)) throw new ManualLlmError(400, `瀏覽器不允許使用此 API Key Header：${headerName}`);
        const headers = { 'Content-Type': 'application/json', Accept: 'application/json', ...parseExtraHeaders(settings.manualLlmExtraHeaders) };
        for (const name of Object.keys(headers)) {
            if (name.toLowerCase() === headerName.toLowerCase()) delete headers[name];
        }
        headers[headerName] = prefix ? `${prefix} ${apiKey}` : apiKey;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
        const abort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', abort, { once: true });
        try {
            if (signal?.aborted) throw new ManualLlmError(499, '手動 LLM 請求已取消。');
            const response = await fetchImpl(url, {
                method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer',
                headers,
                body: JSON.stringify({ model, messages, max_tokens: Math.max(1, Number(maxTokens) || 1), stream: false }),
                signal: controller.signal,
            });
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw new ManualLlmError(response.status, safeError(response.status));
            }
            let bytes;
            try {
                bytes = await readLimited(response, MAX_RESPONSE_BYTES, controller.signal);
            } catch (error) {
                if (error instanceof HttpError) throw new ManualLlmError(502, '手動 LLM 回應超過大小限制或無法完整讀取。');
                throw error;
            }
            let data;
            try {
                data = JSON.parse(new TextDecoder().decode(bytes));
            } catch {
                throw new ManualLlmError(502, '手動 LLM 回傳的內容不是有效 JSON。');
            }
            return extractContent(data);
        } catch (error) {
            if (error instanceof ManualLlmError) throw error;
            if (signal?.aborted) throw new ManualLlmError(499, '手動 LLM 請求已取消。');
            if (controller.signal.aborted) throw new ManualLlmError(504, '手動 LLM 請求逾時。');
            throw new ManualLlmError(502, '瀏覽器無法連線至手動 LLM；請確認網址、CORS、憑證或網路設定。');
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
        }
    }
    return { send };
}
