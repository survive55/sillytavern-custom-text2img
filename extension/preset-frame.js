/** Opaque-origin display frame. Compatibility shims are NOT a security boundary. */
export function displayBlocks(text) {
    const blocks = [], pattern = /```(?:html)?\s*\n?([\s\S]*?)```/gi;
    let cursor = 0;
    for (const match of String(text).matchAll(pattern)) {
        if (match.index > cursor) blocks.push({ text: text.slice(cursor, match.index) });
        blocks.push(/<!doctype\s+html|<html\b/i.test(match[1]) ? { html: match[1] } : { text: match[1] });
        cursor = match.index + match[0].length;
    }
    if (cursor < text.length) {
        const tail = text.slice(cursor);
        blocks.push(/^\s*(?:<!doctype\s+html[^>]*>\s*)?<html\b/i.test(tail) ? { html: tail } : { text: tail });
    }
    return blocks;
}

// This function is serialized into the child. It knows no host settings or secrets.
function bootstrap(channel, origin) {
    const post = window.parent.postMessage.bind(window.parent);
    const textarea = document.createElement('textarea');
    const send = (type, text) => post({ channel, type, text: String(text ?? '').slice(0, 32768) }, origin);
    const generate = () => send('send-request', textarea.value);
    textarea.addEventListener('input', () => send('fill', textarea.value));
    const button = document.createElement('button');
    button.addEventListener('click', generate);
    const context = { extensionSettings: {}, generate, saveSettingsDebounced() {} };
    const facade = {
        document: { getElementById: id => id === 'send_textarea' ? textarea : id === 'send_but' ? button : null, querySelectorAll: () => [] },
        SillyTavern: { getContext: () => context, saveSettingsDebounced() {} },
        postMessage: data => { if (data?.type === 'resizeIframe') post({ channel, type: 'resize', height: Number(data.height) }, origin); },
    };
    Object.defineProperty(window, 'CMIHost', { value: facade, writable: false, configurable: false });
    Object.defineProperty(window, 'CMI', { value: Object.freeze({ fill: text => send('fill', text), send: text => send('send-request', text) }) });
}

export function mountPresetFrame(container, html, { scripts = false, onAction } = {}) {
    if (html.length > 262144) throw new Error('嵌入介面超過 256 KiB，請縮小正則顯示內容。');
    const frame = document.createElement('iframe');
    if (scripts && !('credentialless' in frame)) throw new Error('此瀏覽器不支援 credentialless iframe；只提供靜態預覽，請使用支援的 Chromium 啟用腳本。');
    const channel = crypto.randomUUID();
    const template = document.createElement('template');
    template.innerHTML = html; // Inert template: never attach imported nodes to ST's document.
    template.content.querySelectorAll('base,meta,link,iframe,frame,object,embed').forEach(node => node.remove());
    for (const element of template.content.querySelectorAll('*')) {
        for (const name of ['href', 'action', 'formaction', 'ping', 'target', 'download']) element.removeAttribute(name);
    }
    for (const script of template.content.querySelectorAll('script')) {
        if (!scripts || script.hasAttribute('src') || (script.type && script.type !== 'text/javascript')) { script.remove(); continue; }
        // Limited legacy adapter for this family of widgets. Real parent/top remain
        // cross-origin and inaccessible even if a script bypasses this rewriting.
        script.textContent = script.textContent.replace(/\bwindow\s*\.\s*(parent|top)\b/g, 'window.CMIHost');
    }
    const csp = `default-src 'none'; script-src ${scripts ? "'unsafe-inline'" : "'none'"}; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; media-src 'none'; form-action 'none'; base-uri 'none'`;
    frame.className = 'cmi-preset-frame';
    frame.title = scripts ? '隔離預設互動介面' : '預設介面靜態預覽（腳本未啟用）';
    frame.sandbox.value = scripts ? 'allow-scripts' : '';
    frame.credentialless = true;
    frame.referrerPolicy = 'no-referrer';
    frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'; payment 'none'");
    let remaining = 100, disposed = false;
    const receive = event => {
        if (disposed || event.source !== frame.contentWindow || event.origin !== 'null' || event.data?.channel !== channel) return;
        const data = event.data;
        if (data.type === 'resize' && Number.isFinite(data.height)) { frame.style.height = `${Math.min(700, Math.max(180, data.height))}px`; return; }
        if (!['fill', 'send-request'].includes(data.type) || typeof data.text !== 'string' || data.text.length > 32768 || --remaining < 0) return;
        // A child message is UNTRUSTED. It can suggest text but never call a paid API.
        onAction?.({ type: data.type, text: data.text });
    };
    window.addEventListener('message', receive);
    const shim = scripts ? `<script>(${bootstrap.toString()})(${JSON.stringify(channel)},${JSON.stringify(location.origin)});<\/script>` : '';
    frame.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer">${shim}</head><body>${template.innerHTML}</body></html>`;
    container.append(frame);
    return () => { disposed = true; window.removeEventListener('message', receive); frame.remove(); };
}
