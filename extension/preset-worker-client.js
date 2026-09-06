/** Each task owns a disposable Worker; a hostile regex cannot freeze ST's UI. */
export function runPresetTask(type, payload, signal, timeoutMs = 4000) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./preset-worker.js', import.meta.url), { type: 'module' });
        let timer;
        const finish = (error, value) => {
            clearTimeout(timer); worker.terminate(); signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(new DOMException('已取消獨立提示詞處理。', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(() => finish(new Error('獨立預設處理逾時（4 秒）；已終止 Worker，請檢查正文清理／正則規則。')), timeoutMs);
        worker.onmessage = ({ data }) => data.ok ? finish(null, data.result) : finish(new Error(data.error));
        worker.onerror = () => finish(new Error('無法載入獨立預設 Worker；請重新整理並確認擴展檔案完整。'));
        try { worker.postMessage({ type, payload }); } catch (error) { finish(error); }
    });
}
