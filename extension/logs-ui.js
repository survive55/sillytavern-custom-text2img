import { formatLogEntry } from './logs.js';

/** Text-only rendering: upstream messages/prompts are never interpreted as HTML. */
export function mountLogPanel(root, store) {
    const get = id => root.querySelector(`#${id}`);
    const output = get('cmi_log_output'), summary = get('cmi_log_summary'), status = get('cmi_log_status');
    const filter = get('cmi_log_filter'), run = get('cmi_log_run'), follow = get('cmi_log_follow');
    const detail = get('cmi_log_detail');
    let timer = null;
    const selected = () => store.getEntries().filter(entry => (!run.value || entry.runId === run.value)
        && (filter.value === 'all' || (filter.value === 'problems' ? ['warn', 'error'].includes(entry.level) : entry.level === filter.value)));
    const exportText = () => `Custom Text2Img logs — ${new Date().toISOString()}\n僅目前分頁；可能包含私人提示詞，分享前請檢查。\n\n${selected().map(formatLogEntry).join('\n\n')}`;
    function render() {
        timer = null;
        const all = store.getEntries(), previous = run.value;
        const options = new Map();
        for (const entry of all) if (!options.has(entry.runId)) options.set(entry.runId,
            `${entry.runId} · ${entry.provider}${Number.isInteger(entry.messageId) ? ` · 樓層 ${entry.messageId}` : ''}`);
        run.replaceChildren(new Option('所有任務／操作', ''), ...[...options].reverse().map(([id, label]) => new Option(label, id)));
        run.value = options.has(previous) ? previous : '';
        const visible = selected(), stats = store.stats(), scrollTop = output.scrollTop;
        // Preserve existing text nodes and selections while live events arrive.
        const wanted = new Set(visible.map(entry => String(entry.id)));
        const rows = new Map([...output.children].map(row => [row.dataset.logId, row]));
        for (const [id, row] of rows) if (!wanted.has(id)) row.remove();
        let cursor = output.firstChild;
        for (const entry of visible) {
            const id = String(entry.id);
            let row = rows.get(id);
            if (!row) {
                row = document.createElement('pre');
                row.dataset.logId = id;
                row.className = `cmi-log-entry cmi-log-${entry.level}`;
                row.textContent = formatLogEntry(entry);
            }
            if (row !== cursor) output.insertBefore(row, cursor);
            cursor = row.nextSibling;
        }
        if (!visible.length) {
            const empty = document.createElement('p');
            empty.textContent = '尚無符合條件的紀錄。生成插圖或測試連線後會在此顯示。';
            output.append(empty);
        }
        summary.textContent = `${visible.length} / ${stats.count} 筆${stats.dropped ? `；已淘汰 ${stats.dropped} 筆舊紀錄` : ''}`;
        detail.checked = store.detailed;
        output.scrollTop = follow.checked ? output.scrollHeight : scrollTop;
    }
    const schedule = () => { if (timer === null) timer = setTimeout(render, 100); };
    const unsubscribe = store.subscribe(schedule);
    filter.addEventListener('change', render);
    run.addEventListener('change', render);
    follow.addEventListener('change', render);
    root.addEventListener('toggle', event => { if (event.target.open) render(); }, true);
    detail.addEventListener('change', () => {
        store.setDetailed(detail.checked);
        status.textContent = detail.checked ? '詳細模式已開啟，只記錄之後的內容；分享前請檢查私人資訊。'
            : '詳細模式已關閉；既有詳細紀錄仍在，若需移除請清除日誌。';
    });
    get('cmi_log_clear').addEventListener('click', () => { store.clear(); status.textContent = '已清除；進行中的任務仍會繼續記錄。'; });
    get('cmi_log_copy').addEventListener('click', async () => {
        try {
            await navigator.clipboard.writeText(exportText());
            status.textContent = '已複製目前篩選的日誌。';
        } catch { status.textContent = '無法存取剪貼簿，請使用下載日誌或選取文字複製。'; }
    });
    get('cmi_log_download').addEventListener('click', () => {
        const url = URL.createObjectURL(new Blob([exportText()], { type: 'text/plain;charset=utf-8' }));
        const link = document.createElement('a');
        link.href = url; link.download = `custom-text2img-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        status.textContent = '已下載目前篩選的日誌。';
    });
    render();
    return () => { unsubscribe(); if (timer !== null) clearTimeout(timer); };
}
