import { HttpError, base64ToBytes } from './http.js';

const MAX_IMAGE = 8 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024;
export function decodeMcpImages(result, expectedCount) {
    const blocks = result.content?.filter(item => item.type === 'image') || [];
    if (!blocks.length || blocks.length > expectedCount || blocks.length > 4) throw new HttpError(502, 'MCP 未回傳預期數量的內嵌圖片；不支援伺服器檔案路徑。');
    const seed = result.structuredContent?.seed;
    if (seed != null && (typeof seed !== 'string' || !/^\d{1,20}$/.test(seed) || BigInt(seed) > 18446744073709551615n)) throw new HttpError(502, 'MCP Seed 回應無效或已失去整數精度。');
    let total = 0;
    return blocks.map(block => {
        if (typeof block.data !== 'string' || !block.data.length || block.data.length > Math.ceil(MAX_IMAGE / 3) * 4
            || block.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data)) throw new HttpError(502, 'MCP 圖片 base64 無效或超過 8 MiB。');
        const bytes = base64ToBytes(block.data);
        total += bytes.length;
        if (bytes.length > MAX_IMAGE || total > MAX_TOTAL) throw new HttpError(502, 'MCP 圖片超過大小限制。');
        const png = bytes.length >= 33 && [137, 80, 78, 71, 13, 10, 26, 10].every((n, i) => bytes[i] === n)
            && new TextDecoder().decode(bytes.subarray(12, 16)) === 'IHDR';
        const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
        const webp = bytes.length >= 12 && new TextDecoder().decode(bytes.subarray(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.subarray(8, 12)) === 'WEBP';
        const format = png ? 'png' : jpeg ? 'jpeg' : webp ? 'webp' : '';
        if (!format || block.mimeType !== `image/${format}`) throw new HttpError(502, 'MCP 圖片格式與內容不一致（僅 PNG／JPEG／WebP）。');
        return { format, mime: block.mimeType, seed: seed ?? null, data: block.data, bytes: bytes.length };
    });
}

/** Page-owned wait jobs, analogous to NovelAI. Never resubmit a paid call.
 * Cancelling UI polling leaves the in-flight HTTP request and server job alone.
 */
export function createMcpImages({ now = Date.now, timeoutMs = 905000, retentionMs = 1800000 } = {}) {
    const jobs = new Map(), pending = new Set();
    let busy = false;
    function prune() { for (const [id, job] of jobs) if (job.finished && job.expires <= now()) jobs.delete(id); }
    const snapshot = (job, after = 0) => ({ job_id: job.id, events: job.events.slice(after), next_cursor: job.events.length, finished: job.finished });
    return {
        get busy() { return busy; },
        async settled() { await Promise.allSettled([...pending]); },
        client(mcp) {
            const owner = Symbol('mcp-owner');
            function owned(id) {
                prune(); const job = jobs.get(id);
                if (!job || job.owner !== owner) throw new HttpError(404, 'MCP 生圖暫存已過期或不屬於此操作。');
                return job;
            }
            return {
                async prepare(signal) {
                    const tools = await mcp.listTools(signal);
                    if (!tools.some(tool => tool.name === 'comfyui_generate')) throw new HttpError(409, 'MCP 沒有 comfyui_generate 工具。');
                },
                async submit(payload, signal) {
                    signal?.throwIfAborted(); prune();
                    if (busy) throw new HttpError(409, '本分頁已有 MCP 生圖進行中；停止等待不代表取消，請等候完成。');
                    if (jobs.size >= 16 || [...jobs.values()].reduce((sum, job) => sum + job.bytes, 0) + MAX_TOTAL > 128 * 1024 * 1024) throw new HttpError(503, 'MCP 圖片暫存已滿，未送出生圖。');
                    busy = true;
                    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
                    const job = { id, owner, files: [], bytes: MAX_TOTAL, finished: false, expires: Infinity, events: [{ type: 'accepted', provider: 'anima-mcp', job_id: id }] };
                    jobs.set(id, job);
                    const task = (async () => {
                        try {
                            const result = await mcp.callTool('comfyui_generate', { ...payload, dry_run: false }, undefined, { timeoutMs, maxBytes: 45 * 1024 * 1024 });
                            job.files = decodeMcpImages(result, payload.batch_size);
                            job.bytes = job.files.reduce((sum, file) => sum + file.bytes, 0);
                            job.events.push({ type: 'done', seed: job.files[0].seed, images: job.files.map((file, i) => `${id}/${i}.${file.format}`) });
                        } catch (error) {
                            job.files = []; job.bytes = 0;
                            job.events.push({ type: 'error', status: error.status || 502, message: `${error.message || 'MCP 生圖失敗'} 請查看 MCP 主機輸出／面板歷史，勿直接重送。` });
                        } finally { job.finished = true; job.expires = now() + retentionMs; busy = false; }
                    })();
                    pending.add(task); void task.finally(() => pending.delete(task));
                    return snapshot(job);
                },
                async poll(id, after, signal) {
                    signal?.throwIfAborted(); const job = owned(id);
                    if (!Number.isSafeInteger(after) || after < 0 || after > job.events.length) throw new HttpError(400, 'MCP 事件游標無效。');
                    return snapshot(job, after);
                },
                async output(path, signal) {
                    signal?.throwIfAborted();
                    const match = /^([a-f0-9]{32})\/([0-3])\.(png|jpeg|webp)$/.exec(path);
                    if (!match) throw new HttpError(400, 'MCP 圖片識別碼無效。');
                    const file = owned(match[1]).files[Number(match[2])];
                    if (!file || file.format !== match[3]) throw new HttpError(404, 'MCP 圖片不存在。');
                    return file;
                },
            };
        },
    };
}
