/** Short HTTP requests only: neither tunnel leg needs SSE or WebSockets. */

function waitForPoll(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const onAbort = () => {
            clearTimeout(timer);
            reject(signal.reason);
        };
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

/**
 * Submit once and replay progress by cursor. A failed read can be retried, but
 * a failed submit must not silently queue a second, potentially paid GPU job.
 * Stopping the caller only stops waiting; an accepted job finishes server-side.
 * @param {object} options
 * @returns {Promise<{images: string[], seed: string|null, generationId: number|null}>}
 */
export async function generateWithPolling({ submit, poll, onEvent, onJob, signal, delay = waitForPoll }) {
    signal.throwIfAborted();
    let snapshot;
    try {
        snapshot = await submit(AbortSignal.any([signal, AbortSignal.timeout(30000)]));
    } catch (error) {
        if (!signal.aborted && (!error.status || error.status >= 500)) {
            error.message += '；送出結果不明，請先查看圖片伺服器歷史紀錄，勿直接重複生成。';
        }
        throw error;
    }
    const jobId = snapshot.job_id;
    if (typeof jobId !== 'string' || !/^[a-f0-9]{32}$/.test(jobId)) {
        throw new Error('圖片伺服器沒有回傳有效的任務 ID');
    }
    onJob?.(jobId);
    const images = new Set();
    let cursor = 0;
    let seed = null;
    let generationId = null;
    let finished = false;
    let failures = 0;
    while (true) {
        signal.throwIfAborted();
        if (snapshot) {
            if (!Array.isArray(snapshot.events) || !Number.isSafeInteger(snapshot.next_cursor)
                || snapshot.next_cursor < cursor || snapshot.job_id !== jobId) {
                throw new Error('圖片伺服器的任務回應格式不正確');
            }
            generationId = snapshot.generation_id ?? generationId;
            for (const event of snapshot.events) {
                onEvent(event);
                switch (event.type) {
                    case 'accepted':
                        generationId = event.generation_id ?? generationId;
                        break;
                    case 'image':
                        if (event.path) images.add(event.path);
                        break;
                    case 'done':
                        finished = true;
                        seed = event.seed ?? null;
                        generationId = event.generation_id ?? generationId;
                        for (const path of event.images ?? []) images.add(path);
                        break;
                    case 'error':
                        throw Object.assign(new Error(event.message || '圖片伺服器回報錯誤'),
                            Number.isInteger(event.status) ? { status: event.status } : {});
                    default:
                        break;
                }
            }
            cursor = snapshot.next_cursor;
            if (snapshot.finished) {
                if (!finished) throw new Error('生圖任務已結束但沒有結果，請查看圖片伺服器歷史紀錄');
                return { images: [...images], seed, generationId };
            }
        }
        await delay(Math.min(5000, 1000 * (failures + 1)), signal);
        try {
            snapshot = await poll(jobId, cursor, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
            failures = 0;
        } catch (error) {
            snapshot = null;
            const retryable = !error.status || error.status === 429 || error.status >= 500;
            if (signal.aborted || !retryable || ++failures > 5) throw error;
            onEvent({ type: 'reconnecting', message: '連線暫時中斷，正在重新查詢同一任務…' });
        }
    }
}
