import { displayBlocks, mountPresetFrame } from './preset-frame.js';

/** A page-owned dialog. Imported code never owns the send/accept controls. */
export function showPresetConversation({ initial, onTurn, cleanPrompt, signal }) {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const dialog = document.createElement('dialog');
        dialog.className = 'cmi-preset-conversation';
        dialog.innerHTML = `<h3>獨立生圖提示詞對話</h3>
            <p>只使用此生圖預設。下方對話、變數與選項不寫入 ST 主聊天；圖片尚未生成。</p>
            <div class="cmi-conversation-status" role="status" aria-live="polite"></div>
            <details><summary>本次獨立對話紀錄（純文字）</summary><pre class="cmi-conversation-history"></pre></details>
            <div class="cmi-conversation-display"></div>
            <div class="cmi-conversation-script-controls" hidden>
                <p>嵌入 JS 可讀取這份顯示內容；僅執行你信任的預設。隔離阻止主聊天存取，並限制資源載入，但不是完整的斷網／CPU 沙箱（例如自行導向）。不支援外部腳本、完整酒館助手或 STscript。</p>
                <button type="button" class="menu_button cmi-conversation-enable">本次對話啟用嵌入 JS</button>
                <button type="button" class="menu_button cmi-conversation-disable" hidden>停止嵌入 JS</button>
            </div>
            <label>獨立輸入（選項「直接送出」只填入並提出請求，仍需在此確認）
                <textarea class="text_pole cmi-conversation-input" rows="3" maxlength="32768"></textarea></label>
            <button type="button" class="menu_button cmi-conversation-send">確認送給提示詞 LLM（可能計費）</button>
            <label>最終圖片提示詞（請檢查／編輯，不會自動把互動 HTML 當提示詞）
                <textarea class="text_pole cmi-conversation-prompt" rows="5"></textarea></label>
            <div class="cmi-conversation-actions"><button type="button" class="menu_button cmi-conversation-use">採用提示詞，進入生圖確認</button>
                <button type="button" class="menu_button cmi-conversation-cancel">取消，不生圖</button></div>`;
        const find = selector => dialog.querySelector(selector);
        const status = find('.cmi-conversation-status'), input = find('.cmi-conversation-input'), prompt = find('.cmi-conversation-prompt');
        const display = find('.cmi-conversation-display'), history = find('.cmi-conversation-history');
        const enable = find('.cmi-conversation-enable'), disable = find('.cmi-conversation-disable');
        const send = find('.cmi-conversation-send'), use = find('.cmi-conversation-use');
        const controller = new AbortController();
        let current = initial, scripts = false, busy = false, done = false, disposers = [];
        const clearFrames = () => { for (const dispose of disposers) dispose(); disposers = []; };
        const finish = (result, error) => {
            if (done) return;
            done = true; controller.abort(); clearFrames(); signal?.removeEventListener('abort', abort);
            dialog.close(); dialog.remove();
            if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(null, new DOMException('已取消獨立提示詞對話。', 'AbortError'));
        const setBusy = value => { busy = value; send.disabled = use.disabled = input.disabled = enable.disabled = disable.disabled = value; };
        const render = () => {
            clearFrames(); display.replaceChildren();
            const blocks = displayBlocks(current.display);
            const htmlBlocks = blocks.filter(block => block.html);
            find('.cmi-conversation-script-controls').hidden = htmlBlocks.length === 0;
            if (htmlBlocks.length > 4) throw new Error('每次回覆最多顯示 4 個嵌入介面。');
            for (const block of blocks) {
                if (block.html) disposers.push(mountPresetFrame(display, block.html, { scripts, onAction: action => {
                    if (done || busy) return;
                    input.value = action.text;
                    status.textContent = action.type === 'send-request' ? '嵌入介面提出送出請求。請核對獨立輸入，再按「確認送給提示詞 LLM」。尚未呼叫 API。' : '已填入獨立輸入框；未送出。';
                } }));
                else if (block.text.trim()) { const pre = document.createElement('pre'); pre.textContent = block.text; display.append(pre); }
            }
            enable.hidden = scripts; disable.hidden = !scripts;
        };
        send.addEventListener('click', async event => {
            if (!event.isTrusted || busy || done || !input.value.trim()) return;
            const text = input.value.trim();
            setBusy(true); clearFrames();
            status.textContent = '正在呼叫獨立提示詞 LLM…（失敗不自動重送）';
            try {
                const next = await onTurn(text, controller.signal);
                if (done) return;
                current = next;
                history.textContent += `\n\nUser: ${text}\n\nAssistant: ${next.raw}`;
                input.value = ''; prompt.value = cleanPrompt(next.prompt);
                status.textContent = next.warnings?.join('\n') || '已收到回覆；可繼續對話，或檢查最終提示詞。';
                render();
            } catch (error) {
                if (!done) { status.textContent = `未完成：${String(error?.message || error)}。未自動重送，對話狀態保留於上一輪。`; render(); }
            } finally { if (!done) setBusy(false); }
        });
        enable.addEventListener('click', event => {
            if (!event.isTrusted || busy || done) return;
            scripts = true;
            try { render(); status.textContent = '已啟用本次嵌入介面；腳本送出請求仍需由上方／下方的插件按鈕確認。'; }
            catch (error) { scripts = false; render(); status.textContent = String(error?.message || error); }
        });
        disable.addEventListener('click', event => { if (event.isTrusted && !busy) { scripts = false; render(); } });
        use.addEventListener('click', event => { if (event.isTrusted && !busy && prompt.value.trim()) finish(prompt.value.trim()); });
        find('.cmi-conversation-cancel').addEventListener('click', () => finish(null));
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
        signal?.addEventListener('abort', abort, { once: true });
        try {
            history.textContent = `Assistant: ${initial.raw}`;
            prompt.value = cleanPrompt(initial.prompt);
            status.textContent = initial.warnings?.join('\n') || '可選擇互動選項或直接檢查最終提示詞。';
            render(); document.body.append(dialog); dialog.showModal();
        } catch (error) { finish(null, error); }
    });
}
