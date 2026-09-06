import { buildPresetMessages, getPresetOrder, shouldTriggerPresetPrompt } from './llm-presets.js';
import { applyPresetRegex, boundedText } from './preset-regex.js';
import { createPresetMacros } from './preset-macros.js';
import { cleanScene, cleanSceneText, parseBodyCleanupRules } from './scene-text.js';

export function createPresetState({ preset, orderId, snapshot, bodyCleanupRules, fields, char, user, isGroup = false, groupNames = [] }) {
    const scene = cleanScene(snapshot, bodyCleanupRules);
    const state = { preset, orderId, scene, bodyCleanupRules, fields, char, user, isGroup, groupNames,
        turns: [], macroState: {}, warnings: [] };
    const macros = createPresetMacros({ values: { ...scene.values, char, user, ...fields } });
    const rules = preset.extensions?.regex_scripts ?? [];
    scene.history = scene.history.map((message, index) => ({ ...message,
        text: applyPresetRegex(message.text, rules, { role: message.role, stage: 'raw', depth: scene.history.length - 1 - index, expand: macros.expand }) }));
    state.macroState = macros.snapshot();
    return state;
}
export function preparePresetRequest(previous, userText = null) {
    const state = structuredClone(previous);
    if (state.turns.length >= 40) throw new Error('獨立對話已達 20 輪上限，請結束或重新開始。');
    const rules = state.preset.extensions?.regex_scripts ?? [];
    const values = { ...state.scene.values, char: state.char, user: state.user, ...state.fields };
    const macros = createPresetMacros({ values, ...state.macroState });
    if (userText !== null) {
        const text = cleanSceneText(userText, parseBodyCleanupRules(state.bodyCleanupRules));
        if (!text) throw new Error('獨立輸入清理後為空白。');
        state.turns.push({ role: 'user', text: applyPresetRegex(text, rules, { role: 'user', stage: 'raw', depth: 0, expand: macros.expand }) });
    }
    const all = [...state.scene.history, ...state.turns];
    const latest = all.at(-1);
    Object.assign(values, { message: latest?.text ?? state.scene.target.text, lastMessage: latest?.text ?? '', lastChatMessage: latest?.text ?? '',
        lastUserMessage: all.findLast(item => item.role === 'user')?.text ?? state.scene.values.lastUserMessage,
        lastCharMessage: all.findLast(item => item.role === 'assistant')?.text ?? state.scene.values.lastCharMessage });
    // All message aliases see the same isolated prompt-filtered scene. No raw fallback.
    const processed = all.map((item, index) => ({ ...item,
        text: applyPresetRegex(item.text, rules, { role: item.role, stage: 'prompt', depth: all.length - 1 - index, expand: macros.expand }) }));
    Object.assign(values, { message: processed.at(-1)?.text ?? '', lastMessage: processed.at(-1)?.text ?? '', lastChatMessage: processed.at(-1)?.text ?? '',
        lastUserMessage: processed.findLast(item => item.role === 'user')?.text ?? state.scene.values.lastUserMessage,
        lastCharMessage: processed.findLast(item => item.role === 'assistant')?.text ?? state.scene.values.lastCharMessage,
        history: processed.slice(0, -1).map(item => `${item.name || (item.role === 'user' ? state.user : state.char)}: ${item.text}`).join('\n\n') });
    const fields = {};
    for (const [key, value] of Object.entries(state.fields)) fields[key] = macros.expand(value);
    Object.assign(values, fields);
    const messagesFrom = items => items.map(item => ({ role: item.role,
        content: `${state.isGroup && item.name ? `${item.name}: ` : ''}${item.text}` })).filter(item => item.content.trim());
    const historyEntry = getPresetOrder(state.preset, state.orderId).find(item => item.identifier === 'chatHistory');
    const historyPrompt = state.preset.prompts.find(item => item.identifier === 'chatHistory');
    // chatHistory is a container; its saved role does not override its children.
    const historyOff = historyEntry && (!historyEntry.enabled || !shouldTriggerPresetPrompt(historyPrompt));
    const messages = buildPresetMessages(state.preset, { orderId: state.orderId, fields,
        history: historyOff ? [] : messagesFrom(processed), expand: macros.expand,
        char: state.char, user: state.user, isGroup: state.isGroup, groupNames: state.groupNames });
    // A disabled or non-triggering ST-history marker must not discard explicit
    // independent user turns. Original ST floor data stays excluded.
    if (historyOff) messages.push(...messagesFrom(processed.slice(state.scene.history.length)));
    boundedText(JSON.stringify(messages));
    state.macroState = macros.snapshot();
    state.warnings = [...new Set([...state.warnings, ...macros.warnings])].slice(0, 100);
    return { state, messages };
}
export function acceptPresetResponse(previous, content) {
    const state = structuredClone(previous), rules = state.preset.extensions?.regex_scripts ?? [];
    const macros = createPresetMacros({ values: { ...state.scene.values, ...state.fields, char: state.char, user: state.user }, ...state.macroState });
    // Reasoning returned in a dedicated API field is never read. Inline reasoning
    // follows the same user-editable cleanup as the original ST scene.
    const raw = cleanSceneText(content, parseBodyCleanupRules(state.bodyCleanupRules));
    const text = applyPresetRegex(raw, rules, { role: 'assistant', stage: 'raw', depth: 0, expand: macros.expand });
    if (!text.trim()) throw new Error('提示詞生成模型回覆在清理後為空白。');
    state.turns.push({ role: 'assistant', text });
    state.macroState = macros.snapshot();
    const render = stage => applyPresetRegex(text, rules, { role: 'assistant', stage, depth: 0,
        expand: createPresetMacros({ values: macros.values, ...state.macroState }).expand });
    return { state, raw: text, display: render('display'), prompt: render('prompt'), warnings: state.warnings };
}
