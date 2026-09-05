'use strict';

const { randomBytes, createHash } = require('node:crypto');
const { HttpError, route } = require('./http.js');
const { secrets: hostSecrets, userRoot } = require('./st-secrets.js');
const { buildNovelAIRequest, MODELS } = require('./novelai-payload.js');
const { readImages, readLimited, MAX_IMAGE_TOTAL } = require('./images.js');

const ORIGIN = 'https://image.novelai.net';
const GENERATION_TIMEOUT = 5 * 60 * 1000;
const RETENTION = 30 * 60 * 1000;

function tokenValue(value) {
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.trim())) {
        throw new HttpError(400, '請先儲存有效格式的 NovelAI Persistent API Token（不含 Bearer 前綴）。');
    }
    return value.trim();
}

async function upstreamError(response) {
    // Upstream error bodies may echo prompts or credentials. Do not forward or log them.
    await response.body?.cancel().catch(() => {});
    const messages = {
        400: '請檢查模型及圖片參數。',
        401: 'Token 無效或已過期。',
        402: 'Anlas 不足或需要付費方案。',
        403: '帳號無權使用此模型或服務。',
        422: '圖片參數不被接受。',
        429: '請求過於頻繁；不會自動重送生圖。',
    };
    const status = [400, 401, 402, 403, 422, 429].includes(response.status) ? response.status : 502;
    return new HttpError(status, `NovelAI HTTP ${response.status}：${messages[response.status] || '服務暫時不可用；請勿立即重複生圖。'}`);
}

/** Dependencies are injected by offline tests only; the HTTP API cannot choose another origin. */
function createNovelAI({ secrets = hostSecrets, fetchImpl = (...args) => fetch(...args), now = Date.now,
    timeoutMs = GENERATION_TIMEOUT, retentionMs = RETENTION, maxJobs = 16, maxCacheBytes = 128 * 1024 * 1024 } = {}) {
    const jobs = new Map();
    const pending = new Set();
    const controllers = new Set();
    let timer;

    function prune() {
        for (const [id, job] of jobs) {
            if (job.finished && job.expiresAt <= now()) jobs.delete(id);
        }
    }

    async function callApi(path, token, init, controller, deadline) {
        const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(deadline)]);
        try {
            const response = await fetchImpl(`${ORIGIN}${path}`, {
                ...init, redirect: 'error', signal,
                headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token}` },
            });
            if (!response.ok) throw await upstreamError(response);
            return response;
        } catch (error) {
            if (error instanceof HttpError) throw error;
            if (signal.aborted) throw new HttpError(504, 'NovelAI 請求逾時或服務已停止；已送出的生圖可能仍會扣除 Anlas，不會自動重送。');
            throw new HttpError(502, '無法連線至 NovelAI；送出結果不明，不會自動重送生圖。');
        }
    }

    function snapshot(job, after = 0) {
        return {
            job_id: job.id, events: job.events.slice(after), next_cursor: job.events.length,
            finished: job.finished, expires_at: job.finished ? job.expiresAt : null,
        };
    }

    function ownedJob(req, id) {
        const owner = userRoot(req);
        if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new HttpError(400, 'jobId is invalid');
        prune();
        const job = jobs.get(id);
        if (!job || job.owner !== owner) throw new HttpError(404, 'NovelAI 任務不存在、已過期，或不屬於目前使用者。');
        return job;
    }

    async function generate(job, token, request) {
        try {
            const response = await callApi('/ai/generate-image', token, {
                method: 'POST', body: JSON.stringify(request),
            }, job.controller, timeoutMs);
            job.files = await readImages(response, request.parameters.n_samples);
            job.bytes = job.files.reduce((sum, file) => sum + file.buffer.length, 0);
            job.events.push({
                type: 'done', seed: String(request.parameters.seed),
                images: job.files.map((_file, i) => `${job.id}/${i}.png`),
            });
        } catch (error) {
            const timeout = ['TimeoutError', 'AbortError'].includes(error?.name);
            job.events.push({
                type: 'error', status: error instanceof HttpError ? error.status : timeout ? 504 : 502,
                message: error instanceof HttpError ? error.message
                    : timeout ? 'NovelAI 回應逾時；已送出的生圖可能仍會扣點，不會自動重送。'
                        : 'NovelAI 回應無法讀取；不會自動重送生圖。',
            });
            job.files = [];
            job.bytes = 0;
        } finally {
            job.finished = true;
            job.expiresAt = now() + retentionMs;
            controllers.delete(job.controller);
            delete job.controller;
            delete job.tokenHash;
        }
    }

    function mount(router) {
        timer ??= setInterval(prune, Math.min(retentionMs, 60_000));
        timer.unref();

        router.post('/novelai/status', route(async (req, res) => {
            userRoot(req);
            res.json({ configured: Boolean(await secrets.read(req)), models: MODELS, endpoint: `${ORIGIN}/ai/generate-image` });
        }));

        router.post('/novelai/token', route(async (req, res) => {
            userRoot(req);
            if (req.body?.clear === true) {
                if (req.body.token) throw new HttpError(400, '不能同時儲存及刪除 Token。');
                await secrets.clear(req);
            } else {
                await secrets.write(req, tokenValue(req.body?.token));
            }
            res.json({ ok: true, configured: Boolean(await secrets.read(req)) });
        }));

        router.post('/novelai/test', route(async (req, res) => {
            userRoot(req);
            const token = tokenValue(await secrets.read(req));
            const controller = new AbortController();
            controllers.add(controller);
            try {
                // A documented, authenticated /ai/ read. No paid image is generated.
                const response = await callApi(`/ai/generate-image/suggest-tags?model=${MODELS[0]}&prompt=landscape`, token,
                    { method: 'GET' }, controller, 15_000);
                await readLimited(response, 1024 * 1024);
                res.json({ ok: true, message: 'NovelAI 標籤 API 連線成功（未生圖、不扣 Anlas；不代表模型權限或餘額足夠）。' });
            } finally {
                controllers.delete(controller);
            }
        }));

        router.post('/novelai/jobs', route(async (req, res) => {
            const owner = userRoot(req);
            const request = buildNovelAIRequest(req.body?.payload);
            const token = tokenValue(await secrets.read(req));
            const tokenHash = createHash('sha256').update(token).digest('hex');
            prune();
            if ([...jobs.values()].some(job => !job.finished && (job.owner === owner || job.tokenHash === tokenHash))) {
                throw new HttpError(409, '目前帳號已有 NovelAI 生圖進行中，請等候完成。');
            }
            const budget = [...jobs.values()].reduce((sum, job) => sum + job.bytes, 0);
            if (jobs.size >= maxJobs || budget + MAX_IMAGE_TOTAL > maxCacheBytes) {
                throw new HttpError(503, 'NovelAI 暫存已滿，請稍後再試；未送出生圖請求。');
            }
            const id = randomBytes(16).toString('hex');
            const job = {
                id, owner, tokenHash, finished: false, expiresAt: Infinity,
                files: [], bytes: MAX_IMAGE_TOTAL, controller: new AbortController(),
                events: [{ type: 'accepted', provider: 'novelai', job_id: id }],
            };
            jobs.set(id, job);
            controllers.add(job.controller);
            const task = generate(job, token, request);
            pending.add(task);
            void task.then(() => pending.delete(task), () => pending.delete(task));
            // One accepted job = exactly one upstream generation call. No retries, even on 429.
            res.status(202).json(snapshot(job));
        }));

        router.post('/novelai/job', route(async (req, res) => {
            const job = ownedJob(req, req.body?.jobId);
            const after = req.body?.after ?? 0;
            if (!Number.isSafeInteger(after) || after < 0 || after > job.events.length) throw new HttpError(400, 'after is invalid');
            res.json(snapshot(job, after));
        }));

        router.post('/novelai/output', route(async (req, res) => {
            const match = typeof req.body?.path === 'string' && /^([a-f0-9]{32})\/([0-3])\.png$/.exec(req.body.path);
            if (!match) throw new HttpError(400, 'path is invalid');
            const job = ownedJob(req, match[1]);
            const file = job.files[Number(match[2])];
            if (!job.finished || !file) throw new HttpError(404, 'NovelAI 圖片尚未產生或已不可用。');
            res.json({ format: 'png', mime: 'image/png', seed: file.seed, bytes: file.buffer.length, data: file.buffer.toString('base64') });
        }));
    }

    async function close() {
        clearInterval(timer);
        timer = undefined;
        for (const controller of controllers) controller.abort();
        await Promise.allSettled([...pending]);
        jobs.clear();
        controllers.clear();
    }

    return { mount, close };
}

module.exports = { createNovelAI, ORIGIN };
