import { HttpError, readLimited, withTimeout } from './http.js';

export const MCP_VERSION = '2025-11-25';
export const ANIMA_PROMPT_TOOLS = Object.freeze(['anima_search_codex', 'anima_adapt_prompt', 'anima_assemble_prompt', 'anima_validate_prompt', 'anima_codex_index']);
export const MCP_DEFAULTS = Object.freeze({ mcpUrl: 'http://127.0.0.1:8766/mcp', mcpPromptEnabled: false,
    mcpPromptTools: [...ANIMA_PROMPT_TOOLS], mcpMaxRounds: 6, mcpReadSkill: true, mcpProfileTransport: false,
    mcpApi: 'auto', mcpWorkflow: '', mcpWidth: '832', mcpHeight: '1216', mcpBatchSize: '1',
    mcpSeed: '', mcpNegative: '', mcpSteps: '', mcpCfg: '', mcpSampler: '', mcpScheduler: '' });

export function mcpUrl(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { throw new HttpError(400, 'MCP 網址格式無效。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash
        || (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
        throw new HttpError(400, 'MCP 必須使用 HTTPS（localhost 可 HTTP），不可把憑證放在網址內。');
    }
    return url.href;
}

/** Targeted Anima browser profile, not a general-purpose MCP/stdio gateway.
 * Uses the 2025-11-25 MCP handshake + Streamable HTTP; never retries requests.
 * The companion server uses stateless JSON responses. Bounded SSE responses
 * are also parsed, but unsolicited sampling/elicitation is not advertised.
 */
export function createMcpClient({ url, token, fetchImpl = (...args) => fetch(...args) }) {
    url = mcpUrl(url);
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(token)) throw new HttpError(400, '請先套用 MCP Token（32–256 字元）；Token 僅保存在目前分頁。');
    let nextId = 0, session = '', connecting;
    async function request(method, params, signal, { timeoutMs = 30000, maxBytes = 1024 * 1024, notification = false } = {}) {
        signal?.throwIfAborted();
        const id = notification ? undefined : ++nextId;
        const deadline = withTimeout(signal, timeoutMs);
        let response;
        try {
            response = await fetchImpl(url, { method: 'POST', mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: deadline,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', Authorization: `Bearer ${token}`,
                    ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': MCP_VERSION }), ...(session ? { 'Mcp-Session-Id': session } : {}) },
                body: JSON.stringify({ jsonrpc: '2.0', ...(id === undefined ? {} : { id }), method, params }) });
            if (!response.ok) {
                await response.body?.cancel().catch(() => {});
                throw new HttpError(response.status, `MCP HTTP ${response.status}：${response.status === 401 ? 'Token 無效。' : response.status === 403 ? 'ST Origin 未获允許。' : '請檢查 MCP 服務與連線；不會自動重送。'}`);
            }
            if (notification) {
                await response.body?.cancel().catch(() => {});
                if (![202, 204].includes(response.status)) throw new HttpError(502, 'MCP 沒有正確接受初始化通知。');
                return;
            }
            const text = new TextDecoder().decode(await readLimited(response, maxBytes, deadline));
            let packet;
            if (response.headers.get('content-type')?.includes('text/event-stream')) {
                const messages = text.replace(/\r\n?/g, '\n').split('\n\n').map(event => event.split('\n')
                    .filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')).filter(Boolean).map(data => JSON.parse(data));
                packet = messages.find(message => message.id === id && ('result' in message || 'error' in message));
            } else if (response.headers.get('content-type')?.includes('application/json')) packet = JSON.parse(text);
            if (!packet || packet.jsonrpc !== '2.0' || packet.id !== id) throw new HttpError(502, 'MCP 回應格式或請求 ID 不正確。');
            if (packet.error) throw new HttpError(502, `MCP ${method} 被拒絕（RPC ${Number(packet.error.code) || 'error'}）；請檢查參數與服務版本。`);
            if (!packet.result || typeof packet.result !== 'object') throw new HttpError(502, 'MCP 沒有有效結果。');
            if (method === 'initialize') {
                const header = response.headers.get('mcp-session-id');
                if (header && !/^[\x21-\x7e]{1,256}$/.test(header)) throw new HttpError(502, 'MCP Session ID 無效。');
                session = header || '';
            }
            return packet.result;
        } catch (error) {
            if (signal?.aborted) throw signal.reason;
            if (error instanceof HttpError) throw error;
            throw new HttpError(deadline.aborted ? 504 : 502, deadline.aborted
                ? 'MCP 請求逾時；已送出生圖可能仍會計費，請勿直接重送。'
                : 'MCP 回應無法讀取；請檢查 CORS、HTTPS、網路與服務版本。不會自動重送。');
        }
    }
    async function connect(signal) {
        if (!connecting) connecting = (async () => {
            const info = await request('initialize', { protocolVersion: MCP_VERSION, capabilities: {}, clientInfo: { name: 'custom-text2img', version: '3.3.0' } }, signal);
            if (info.protocolVersion !== MCP_VERSION || info.serverInfo?.name !== 'anima-comfyui-browser' || !info.capabilities?.tools) {
                throw new HttpError(409, '請使用 Mcp-image 的 browser_server.py（Anima browser profile），不是原始 stdio 入口或其他 MCP。');
            }
            await request('notifications/initialized', {}, signal, { notification: true });
            return info;
        })();
        return connecting;
    }
    return {
        connect,
        async listTools(signal) {
            await connect(signal);
            const tools = []; let cursor;
            for (let page = 0; page < 8; page++) {
                const result = await request('tools/list', cursor ? { cursor } : {}, signal);
                if (!Array.isArray(result.tools) || tools.length + result.tools.length > 64) throw new HttpError(502, 'MCP 工具清單超過限制或格式無效。');
                tools.push(...result.tools);
                if (!result.nextCursor) return tools;
                if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) break;
                cursor = result.nextCursor;
            }
            throw new HttpError(502, 'MCP 工具清單分頁超過限制。');
        },
        async readSkill(signal) {
            await connect(signal);
            const result = await request('resources/read', { uri: 'pomelo://SKILL.md' }, signal);
            const text = (result.contents || []).map(item => typeof item.text === 'string' ? item.text : '').join('\n');
            if (!text || text.length > 50000) throw new HttpError(502, 'Anima SKILL 資料為空或超過 50000 字元。');
            return text;
        },
        async callTool(name, args, signal, options) {
            await connect(signal);
            const result = await request('tools/call', { name, arguments: args }, signal, options);
            if (result.isError) throw new HttpError(502, `MCP 工具 ${name} 執行失敗；請檢查參數／服務狀態，勿自動重送付費操作。`);
            return result;
        },
    };
}

export function mcpText(result, maxLength = 24000) {
    const text = result.structuredContent ? JSON.stringify(result.structuredContent)
        : (result.content || []).filter(item => item.type === 'text').map(item => item.text).join('\n');
    if (!text || text.length > maxLength) throw new HttpError(502, 'MCP 工具文字結果為空或超過上下文限制。');
    return text;
}

export function buildMcpPayload(prompt, settings) {
    const payload = { prompt, api: settings.mcpApi, workflow: settings.mcpWorkflow || null,
        negative_prompt: settings.mcpNegative || '', width: Number(settings.mcpWidth), height: Number(settings.mcpHeight), batch_size: Number(settings.mcpBatchSize) };
    if (!['auto', 'panel', 'comfyui'].includes(payload.api)) throw new HttpError(400, 'MCP 生圖 API 無效。');
    if (!String(prompt).trim() || prompt.length > 16000 || payload.negative_prompt.length > 16000) throw new HttpError(400, 'MCP 提示詞為空或超過 16000 字元。');
    if (![payload.width, payload.height].every(n => Number.isInteger(n) && n >= 64 && n <= 2048 && n % 8 === 0)
        || !Number.isInteger(payload.batch_size) || payload.batch_size < 1 || payload.batch_size > 4
        || payload.width * payload.height * payload.batch_size > 4194304) throw new HttpError(400, 'MCP 寬高需為 64–2048、8 的倍數；批次 1–4、總計最多 4194304 像素。');
    const seed = String(settings.mcpSeed ?? '').trim();
    if (seed && seed !== '-1') {
        if (!/^\d{1,20}$/.test(seed) || BigInt(seed) > 18446744073709551615n) throw new HttpError(400, 'MCP Seed 需為 0–18446744073709551615。');
        payload.seed = seed;
    }
    for (const [key, field, min, max, integer] of [['steps', 'mcpSteps', 1, 100, true], ['cfg', 'mcpCfg', 0, 30, false]]) {
        if (String(settings[field] ?? '').trim()) {
            const value = Number(settings[field]);
            if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new HttpError(400, `MCP ${key} 參數無效。`);
            payload[key] = value;
        }
    }
    for (const [key, field] of [['sampler', 'mcpSampler'], ['scheduler', 'mcpScheduler']]) if (String(settings[field] || '').trim()) payload[key] = String(settings[field]).trim();
    return payload;
}
