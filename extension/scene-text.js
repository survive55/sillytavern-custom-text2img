import { boundedText, compileRegex } from './preset-regex.js';
import { stripSceneMarkers } from './inline-scenes.js';

// Editable data, not a hardcoded requirement for a particular story wrapper.
export const DEFAULT_BODY_CLEANUP = JSON.stringify([
    { findRegex: '/<(thinking|think)\\b[^>]*>[\\s\\S]*?(?:<\\/\\1\\s*>|$)/gi', replaceString: '' },
], null, 2);
// Direct ST assistant mes is the default. The thinking example is an optional preset.
export const SCENE_DEFAULTS = Object.freeze({ bodyCleanupRules: '[]' });
export function parseBodyCleanupRules(text = '[]') {
    let rules;
    try { rules = JSON.parse(text); } catch { throw new Error('樓層正文清理規則不是有效 JSON；不會退回未清理全文。'); }
    if (!Array.isArray(rules) || rules.length > 50) throw new Error('正文清理規則必須是最多 50 條的陣列。');
    return rules.map(rule => {
        if (!rule || typeof rule.findRegex !== 'string' || typeof rule.replaceString !== 'string') throw new Error('正文清理規則需有 findRegex、replaceString 字串。');
        try { compileRegex(rule.findRegex); } catch { throw new Error('正文清理規則的正則語法無效。'); }
        return { findRegex: boundedText(rule.findRegex), replaceString: boundedText(rule.replaceString) };
    });
}
export function cleanSceneText(text, rules) {
    let result = boundedText(text);
    for (const rule of rules) result = boundedText(result.replace(compileRegex(rule.findRegex), rule.replaceString));
    return result.trim();
}
/** ST normally uses is_user/is_system; an explicit non-assistant role must never slip through. */
export function isAssistantSceneMessage(message) {
    return Boolean(message && !message.is_user && !message.is_system && message.extra?.type !== 'narrator'
        && (message.role == null || message.role === 'assistant'));
}
/** Select before crossing into a Worker: do not copy settings, credentials or future chat. */
export function snapshotScene(chat, messageId, depth) {
    const visible = chat.slice(0, messageId + 1).map((message, id) => ({ message, id }))
        .filter(({ message }) => isAssistantSceneMessage(message) && String(message.mes ?? '').trim());
    const pack = entry => ({ id: entry.id, role: 'assistant', name: String(entry.message.name ?? ''), text: stripSceneMarkers(entry.message.mes) });
    const target = visible.find(entry => entry.id === messageId);
    if (!target) throw new Error('找不到可讀取的 assistant 目標樓層。');
    return { target: pack(target), history: visible.slice(-Math.min(51, Math.max(1, Math.floor(Number(depth) || 0) + 1))).map(pack),
        lastUser: null, lastChar: pack(target) };
}
export function cleanScene(snapshot, cleanup) {
    const rules = parseBodyCleanupRules(cleanup);
    // This is main-chat scene data, not independent panel input. Recheck the
    // boundary so legacy snapshots cannot populate user history or aliases.
    const clean = message => message?.role === 'assistant' ? { ...message, text: cleanSceneText(message.text, rules) } : null;
    const target = clean(snapshot.target);
    if (!target?.text) throw new Error('目標樓層清理後沒有正文；未送出 LLM 或生圖請求。');
    const history = snapshot.history.map(clean).filter(message => message?.text);
    const lastChar = clean(snapshot.lastChar);
    const values = { message: target.text, lastChatMessage: target.text, lastMessage: target.text, lastMessageId: String(target.id),
        lastUserMessage: '', lastCharMessage: lastChar?.text ?? '',
        history: history.filter(message => message.id !== target.id).map(message => `${message.name}: ${message.text}`).join('\n\n') };
    return { target, history, values };
}
