import { HttpError, bytesToBase64, normalizeToken, readLimited, withTimeout } from './http.js';
import { buildNovelAIRequest, MODELS } from './novelai-payload.js';
import { MAX_IMAGE_TOTAL, readImages } from './images.js';

export const NOVELAI_ORIGIN = 'https://image.novelai.net';
const BILLING_WARNING = '已送出的生圖可能仍會扣除 Anlas，不會自動重送。';

async function upstreamError(response) {
    // Upstream error bodies can contain credentials/prompts. Never echo them.
    await response.body?.cancel().catch(() => {});
    const messages = {
        400: '請檢查模型及圖片參數。', 401: 'Token 無效或已過期。', 402: 'Anlas 不足或需要付費方案。',
        403: '帳號無權使用此模型或服務。', 422: '圖片參數不被接受。', 429: '請求過於頻繁；不會自動重送生圖。',
    };
    return new HttpError([400, 401, 402, 403, 422, 429].includes(response.status) ? response.status : 502,
        `NovelAI HTTP ${response.status}：${messages[response.status] || '服務暫時不可用；請勿立即重複生圖。'}`);
}

async function acquireAccountLock(token, locks) {
    if (!locks?.request) return () => {};
    const hash = crypto.subtle
        ? bytesToBase64(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))))
        : 'all-accounts';
    return new Promise((resolve, reject) => {
        void locks.request(`custom-text2img/novelai/${hash}`, { ifAvailable: true }, async lock => {
            if (!lock) throw new HttpError(409, '此瀏覽器的另一個 ST 分頁正在使用同一 NovelAI Token 生圖，請等候完成。');
            await new Promise(release => resolve(release));
        }).catch(reject);
    });
}

/** Page-owned jobs: stopping the waiter does not resubmit/cancel a paid request.
 * They cannot survive closing/reloading the page; the UI explicitly says so.
 * Dependencies can be injected by offline tests, never by an extension setting.
 */
export function createNovelAI({ fetchImpl = (...args) => fetch(...args), now = Date.now,
    timeoutMs = 5 * 60 * 1000, retentionMs = 30 * 60 * 1000, maxJobs = 16,
    maxCacheBytes = 128 * 1024 * 1024, locks = globalThis.navigator?.locks } = {}) {
    const jobs = new Map(), pending = new Set(), controllers = new Set();
    let running = false, closed = false;

    function prune() {
        for (const [id, job] of jobs) if (job.finished && job.expiresAt <= now()) jobs.delete(id);
    }
    function snapshot(job, after = 0) {
        return { job_id: job.id, events: job.events.slice(after), next_cursor: job.events.length,
            finished: job.finished, expires_at: job.finished ? job.expiresAt : null };
    }
    function ownedJob(owner, id) {
        prune();
        const job = typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) ? jobs.get(id) : null;
        if (!job || job.owner !== owner) throw new HttpError(404, 'NovelAI 任務不存在或已過期（任務只保存在目前分頁）。');
        return job;
    }

    async function callApi(path, token, init, signal) {
        try {
            const response = await fetchImpl(`${NOVELAI_ORIGIN}${path}`, {
                ...init, mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
            });
            if (!response.ok) throw await upstreamError(response);
            return response;
        } catch (error) {
            if (error instanceof HttpError) throw error;
            if (signal?.aborted) throw new HttpError(504, `NovelAI 請求逾時或已中止；${BILLING_WARNING}`);
            throw new HttpError(502, `瀏覽器無法連線至 NovelAI；請確認網路、CORS 或瀏覽器攔截。${BILLING_WARNING}`);
        }
    }

    async function generate(job, token, request, release) {
        const signal = withTimeout(job.controller.signal, timeoutMs);
        try {
            const response = await callApi('/ai/generate-image', token, { method: 'POST', body: JSON.stringify(request) }, signal);
            job.files = await readImages(response, request.parameters.n_samples, signal);
            job.bytes = job.files.reduce((sum, file) => sum + file.bytes.length, 0);
            job.events.push({ type: 'done', seed: String(request.parameters.seed), images: job.files.map((_, i) => `${job.id}/${i}.png`) });
        } catch (error) {
            job.events.push({ type: 'error', status: signal.aborted ? 504 : error.status || 502,
                message: signal.aborted ? `NovelAI 回應逾時；${BILLING_WARNING}`
                    : error instanceof HttpError ? error.message : `NovelAI 回應無法讀取；${BILLING_WARNING}` });
            job.files = []; job.bytes = 0;
        } finally {
            job.finished = true; job.expiresAt = now() + retentionMs;
            controllers.delete(job.controller); delete job.controller;
            running = false; release();
        }
    }

    function client(value) {
        const token = normalizeToken(value), owner = Symbol('novelai-client');
        return {
            prepare: async signal => { signal?.throwIfAborted(); },
            async test(signal) {
                const deadline = withTimeout(signal, 15000);
                const response = await callApi(`/ai/generate-image/suggest-tags?model=${MODELS[0]}&prompt=landscape`, token, { method: 'GET' }, deadline);
                await readLimited(response, 1024 * 1024, deadline);
                return { ok: true, message: 'NovelAI 瀏覽器直連成功（標籤 API；未生圖、不扣 Anlas，不代表模型權限或餘額足夠）。' };
            },
            async submit(payload, signal) {
                signal?.throwIfAborted();
                if (closed) throw new HttpError(503, 'NovelAI 用戶端已停止。');
                const request = buildNovelAIRequest(payload);
                prune();
                if (running) throw new HttpError(409, '此分頁已有 NovelAI 生圖進行中，請等候完成；停止等待不會取消生圖。');
                const budget = [...jobs.values()].reduce((sum, job) => sum + job.bytes, 0);
                if (jobs.size >= maxJobs || budget + MAX_IMAGE_TOTAL > maxCacheBytes) throw new HttpError(503, 'NovelAI 暫存已滿，請稍後再試；未送出生圖請求。');
                running = true;
                let release;
                try {
                    release = await acquireAccountLock(token, locks);
                    signal?.throwIfAborted();
                    if (closed) throw new HttpError(503, 'NovelAI 用戶端已停止。');
                    const id = [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
                    const job = { id, owner, finished: false, expiresAt: Infinity, files: [], bytes: MAX_IMAGE_TOTAL,
                        controller: new AbortController(), events: [{ type: 'accepted', provider: 'novelai', job_id: id }] };
                    jobs.set(id, job); controllers.add(job.controller);
                    const task = generate(job, token, request, release);
                    pending.add(task);
                    void task.then(() => pending.delete(task));
                    return snapshot(job);
                } catch (error) {
                    running = false; release?.(); throw error;
                }
            },
            async poll(id, after, signal) {
                signal?.throwIfAborted();
                const job = ownedJob(owner, id);
                if (!Number.isSafeInteger(after) || after < 0 || after > job.events.length) throw new HttpError(400, 'after is invalid');
                return snapshot(job, after);
            },
            async output(path, signal) {
                signal?.throwIfAborted();
                const match = typeof path === 'string' && /^([a-f0-9]{32})\/([0-3])\.png$/.exec(path);
                if (!match) throw new HttpError(400, '圖片路徑無效。');
                const job = ownedJob(owner, match[1]), file = job.files[Number(match[2])];
                if (!job.finished || !file) throw new HttpError(404, 'NovelAI 圖片尚未產生或已不可用。');
                return { format: 'png', mime: 'image/png', seed: file.seed, bytes: file.bytes.length, data: bytesToBase64(file.bytes) };
            },
        };
    }

    return {
        client,
        get busy() { return running; },
        async close() {
            closed = true;
            for (const controller of controllers) controller.abort();
            await Promise.allSettled([...pending]);
            jobs.clear();
        },
    };
}
