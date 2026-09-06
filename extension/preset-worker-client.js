/** Each task owns a disposable Worker. No time limit; Stop can terminate even a stuck regex. */
export function runPresetTask(type, payload, signal) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const worker = new Worker(new URL('./preset-worker.js', import.meta.url), { type: 'module' });
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            worker.onmessage = worker.onerror = worker.onmessageerror = null;
            worker.terminate(); signal?.removeEventListener('abort', abort);
            if (error) reject(error); else resolve(value);
        };
        const abort = () => finish(new DOMException('已取消獨立提示詞處理。', 'AbortError'));
        signal?.addEventListener('abort', abort, { once: true });
        worker.onmessage = ({ data }) => {
            if (data?.ok === true) return finish(null, data.result);
            const detail = data?.error;
            const error = new Error(`獨立預設 ${type} 失敗：${detail?.message || (typeof detail === 'string' ? detail : 'Worker 未回傳有效結果。')}`);
            if (detail?.name) error.name = detail.name;
            if (detail?.stack) error.stack = `${error.name}: ${error.message}\nWorker stack:\n${detail.stack}`;
            finish(error);
        };
        worker.onerror = event => {
            const location = event.filename ? `（${event.filename}:${event.lineno || 0}:${event.colno || 0}）` : '';
            finish(new Error(`獨立預設 ${type} Worker 載入或執行失敗：${event.message || '瀏覽器未提供原因；請重新整理並確認擴展檔案完整。'}${location}`));
        };
        worker.onmessageerror = () => finish(new Error(`獨立預設 ${type} 失敗：無法讀取 Worker 回傳的資料。`));
        if (signal?.aborted) return abort();
        try { worker.postMessage({ type, payload }); } catch (error) { finish(error); }
    });
}
