/** Page-memory diagnostics only. Never pass settings, headers or image bytes to the log. */
const REDACTED = '[REDACTED]';
const OMITTED = '[omitted]';
const SECRET_KEY = /auth|cookie|password|passphrase|secret|api.?key|token|credential|vault|ciphertext|headers/i;
const TOKEN_COUNT_KEY = /^(?:max_?tokens|openai_max_tokens|token_?count)$/i;
const IMAGE_KEY = /^(?:data|image|images|base64|bytes|buffer)$/i;

/** Exact values cover custom auth headers; patterns cover common echoed credentials. */
export function createLogRedactor(secrets = []) {
    const values = [...new Set(secrets.filter(value => typeof value === 'string' && value.length)
        .flatMap(value => [value, value.trim(), encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]))]
        .filter(Boolean).sort((a, b) => b.length - a.length);
    function text(value) {
        let result = String(value ?? '');
        for (const secret of values) result = result.split(secret).join(REDACTED);
        return result
            .replace(/\b(?:Bearer|Basic)\s+[^\s"'<>;,]+/gi, REDACTED)
            .replace(/\bb1\.[A-Za-z0-9_-]+\.[a-f0-9]{64}\b/gi, REDACTED)
            .replace(/\bsk-[A-Za-z0-9_-]+\b/g, REDACTED)
            .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|passphrase|authorization|cookie|secret)["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;&}]+)/gi, `$1${REDACTED}`)
            .replace(/https?:\/\/[^\s<>"']+/gi, value => {
                try {
                    const url = new URL(value);
                    const hidden = Boolean(url.username || url.password || url.search || url.hash);
                    url.username = ''; url.password = ''; url.search = ''; url.hash = '';
                    return url.href + (hidden ? '[URL credentials/query/fragment omitted]' : '');
                } catch { return '[URL omitted]'; }
            })
            .replace(/data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+/gi, '[image omitted]')
            .replace(/(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)[A-Za-z0-9+/=]+/g, '[image omitted]')
            .replace(/[A-Za-z0-9+/=_-]{256,}/g, '[long encoded value omitted]')
            .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '');
    }
    function sanitize(value, depth = 0, seen = new WeakSet()) {
        if (typeof value === 'string') return text(value).slice(0, 16000);
        if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
        if (typeof value === 'bigint') return String(value);
        if (typeof value !== 'object') return undefined;
        if (depth > 8 || seen.has(value)) return OMITTED;
        if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return '[binary omitted]';
        seen.add(value);
        if (Array.isArray(value)) return value.slice(0, 100).map(item => sanitize(item, depth + 1, seen));
        return Object.fromEntries(Object.entries(value).slice(0, 100).map(([key, item]) => [text(key),
            SECRET_KEY.test(key) && !(TOKEN_COUNT_KEY.test(key) && Number.isFinite(item)) ? REDACTED
                : IMAGE_KEY.test(key) ? OMITTED : sanitize(item, depth + 1, seen)]));
    }
    return { text, sanitize };
}

export function logSecrets(settings = {}, sessionToken = '') {
    let extra = [];
    try { extra = Object.values(JSON.parse(settings.manualLlmExtraHeaders || '{}')).map(String); } catch { /* Not logged. */ }
    return [settings.password, settings.manualLlmApiKey, sessionToken, ...extra];
}

export function formatLogEntry(entry) {
    const location = [entry.runId, entry.provider, Number.isInteger(entry.messageId) ? `樓層 ${entry.messageId}` : null].filter(Boolean).join(' · ');
    return `[${entry.timestamp}] ${entry.level.toUpperCase()} [${location}] +${(entry.elapsedMs / 1000).toFixed(2)}s [${entry.stage}] ${entry.message}${entry.data ? `\n${entry.data}` : ''}`;
}

export function createLogStore({ maxEntries = 500, maxChars = 1024 * 1024, maxEntryChars = 16000, now = Date.now } = {}) {
    const entries = [], listeners = new Set();
    let sequence = 0, runSequence = 0, chars = 0, dropped = 0, detailed = false;
    const notify = () => { for (const listener of listeners) { try { listener(); } catch { /* Diagnostics cannot break generation. */ } } };
    const limit = Math.min(maxEntryChars, maxChars);
    return {
        get detailed() { return detailed; },
        setDetailed(value) { detailed = Boolean(value); notify(); },
        getEntries() { return entries.slice(); },
        stats() { return { count: entries.length, dropped, chars, maxEntries, maxChars }; },
        subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
        clear() { entries.length = 0; chars = 0; dropped = 0; notify(); },
        startRun({ provider = 'runtime', messageId } = {}, secrets = []) {
            const runId = `R${++runSequence}`, started = now(), redactor = createLogRedactor(secrets);
            function add(stage, message, { level = 'info', data, detail = false } = {}) {
                if (detail && !detailed) return;
                try {
                    const entry = {
                        id: ++sequence, timestamp: new Date(now()).toISOString(), runId,
                        provider: redactor.text(provider).slice(0, 80), messageId: Number.isInteger(messageId) ? messageId : undefined,
                        elapsedMs: Math.max(0, now() - started), level: ['info', 'warn', 'error', 'debug'].includes(level) ? level : 'info',
                        stage: redactor.text(stage).slice(0, 100), message: redactor.text(message).slice(0, Math.floor(limit / 2)),
                    };
                    if (data !== undefined) {
                        const serialized = JSON.stringify(redactor.sanitize(data), null, 2) ?? '';
                        const budget = Math.max(0, limit - formatLogEntry(entry).length - 40);
                        entry.data = serialized.length > budget ? `${serialized.slice(0, budget)}\n[truncated]` : serialized;
                    }
                    const size = formatLogEntry(entry).length;
                    if (size > maxChars) { dropped++; notify(); return; }
                    entries.push(Object.freeze(entry)); chars += size;
                    while (entries.length > maxEntries || chars > maxChars) { chars -= formatLogEntry(entries.shift()).length; dropped++; }
                    notify();
                } catch { /* Never store raw fallback data or interfere with a paid job. */ }
            }
            return {
                id: runId, add,
                detail(stage, message, data) { add(stage, message, { level: 'debug', data, detail: true }); },
                error(stage, error) {
                    // Provider errors may echo entire prompts or workflow bodies.
                    // Default logs keep only an allowlisted summary and numeric status.
                    const status = Number.isInteger(error?.status) ? error.status : undefined;
                    const descriptions = { 400: '請求或設定無效', 401: '憑證無效或登入過期', 402: '餘額不足或需付費方案',
                        403: '權限不足', 404: '找不到資源或端點', 409: '任務衝突或設定不相容', 413: '內容超過大小限制',
                        422: '參數不被接受', 429: '請求過於頻繁或額度不足', 499: '請求已取消', 502: '上游服務或網路錯誤',
                        503: '服務暫時不可用', 504: '請求逾時' };
                    add(stage, `操作失敗：${descriptions[status] || '請檢查此階段的設定、連線或服務回應'}。原始錯誤僅在詳細模式記錄；勿直接重複提交付費生圖。`,
                        { level: 'error', data: { status } });
                    add(stage, '原始錯誤（詳細模式）', { level: 'debug', detail: true,
                        data: { message: String(error?.message || error), stack: error?.stack } });
                },
            };
        },
    };
}
