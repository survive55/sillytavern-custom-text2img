/**
 * Isolated Chat Completion preset adapter. No oai_settings / PromptManager state
 * is changed. See docs/llm-presets.md for the ST source contract and boundaries.
 */
export const LLM_PRESET_DEFAULTS = Object.freeze({
    promptPresetMode: 'template', llmPresets: [], llmPresetId: '',
});
export const MAX_PRESET_BYTES = 2 * 1024 * 1024;
const GLOBAL_ORDER = '100001';
const MARKERS = ['worldInfoBefore', 'worldInfoAfter', 'personaDescription', 'charDescription',
    'charPersonality', 'scenario', 'dialogueExamples', 'chatHistory'];
// PromptManager's default order, not the storage order of `prompts`.
const DEFAULT_ORDER = ['main', 'worldInfoBefore', 'personaDescription', 'charDescription',
    'charPersonality', 'scenario', 'enhanceDefinitions', 'nsfw', 'worldInfoAfter',
    'dialogueExamples', 'chatHistory', 'jailbreak'];
const LEGACY = { main_prompt: 'main', nsfw_prompt: 'nsfw', jailbreak_prompt: 'jailbreak' };
const FORMATS = ['new_chat_prompt', 'new_group_chat_prompt', 'new_example_chat_prompt',
    'scenario_format', 'personality_format'];
// Deliberately portable: do not import routing, headers, secrets, tools, n or
// custom bodies from an untrusted preset. Both transports use this allowlist.
const SAMPLERS = {
    temperature: ['temp_openai', 0, 2], top_p: ['top_p_openai', 0, 1],
    frequency_penalty: ['freq_pen_openai', -2, 2], presence_penalty: ['pres_pen_openai', -2, 2],
    seed: ['seed', -1, Number.MAX_SAFE_INTEGER],
};
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw new Error(`LLM 預設：${message}`); };

function numeric(value, key, min, max, integer = false) {
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') fail(`${key} 必須是數字。`);
    const number = Number(value);
    if (!Number.isFinite(number) || number < min || number > max || (integer && !Number.isSafeInteger(number))) {
        fail(`${key} 超出有效範圍。`);
    }
    return number;
}

export function presetSampling(preset) {
    const result = {};
    for (const [key, [alias, min, max]] of Object.entries(SAMPLERS)) {
        const value = Object.hasOwn(preset, key) ? preset[key] : preset[alias];
        if (value === undefined) continue;
        const number = numeric(value, key, min, max, key === 'seed');
        if (key !== 'seed' || number !== -1) result[key] = number;
    }
    return result;
}

function normalizeOrder(order) {
    if (!Array.isArray(order)) fail('prompt_order 的 order 必須是陣列。');
    const seen = new Set();
    return order.map(entry => {
        if (!plain(entry) || typeof entry.identifier !== 'string' || !entry.identifier) fail('順序項目缺少 identifier。');
        if (seen.has(entry.identifier)) fail('同一順序重複引用 identifier。');
        seen.add(entry.identifier);
        if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') fail('enabled 必須是布林值。');
        // ST tests entry.enabled, not prompt.enabled. Missing is disabled.
        return { identifier: entry.identifier, enabled: entry.enabled === true };
    });
}

/** Parse a full ST CC export, a Prompt Manager export, or a pre-PM CC preset. */
export function importLlmPreset(text, filename = 'LLM preset.json') {
    if (new TextEncoder().encode(text).length > MAX_PRESET_BYTES) fail('JSON 不可超過 2 MiB。');
    let raw;
    try { raw = JSON.parse(String(text).replace(/^\uFEFF/, '')); }
    catch { fail('檔案不是有效的 JSON。'); }
    const normalized = normalizeLlmPreset(raw);
    return { ...normalized, name: String(raw.name || filename.replace(/\.json$/i, '') || 'LLM preset').slice(0, 160) };
}

export function normalizeLlmPreset(raw) {
    if (!plain(raw)) fail('請匯入 Chat Completion JSON 物件。');
    let source = raw;
    const warnings = [];
    if (Object.hasOwn(raw, 'data') && Object.hasOwn(raw, 'version')) {
        if (raw.version !== 1 || !['full', 'character'].includes(raw.type) || !plain(raw.data)) fail('不支援此 Prompt Manager 匯出版本。');
        source = raw.data;
    }
    if (!Array.isArray(source.prompts) && !Object.keys(LEGACY).some(key => typeof source[key] === 'string')) {
        fail('不是 Chat Completion 提示詞預設（需有 prompts 或舊版 main_prompt 等欄位）；不支援面板、Text Completion 或 Instruct 預設。');
    }
    if (source.prompts !== undefined && !Array.isArray(source.prompts)) fail('prompts 必須是陣列。');
    const map = new Map();
    for (const item of source.prompts ?? []) {
        if (!plain(item) || typeof item.identifier !== 'string' || !item.identifier) fail('提示詞缺少 identifier。');
        if (map.has(item.identifier)) warnings.push('重複 identifier 已按 ST 匯入規則保留最後一項。');
        if (item.content !== undefined && typeof item.content !== 'string') fail('content 必須是字串。');
        const role = item.role ?? 'system';
        if (!['system', 'user', 'assistant'].includes(role)) fail('role 必須是 system、user 或 assistant。');
        if (item.injection_trigger !== undefined && (!Array.isArray(item.injection_trigger)
            || item.injection_trigger.some(trigger => typeof trigger !== 'string'))) fail('injection_trigger 必須是字串陣列。');
        const marker = item.marker === true || MARKERS.includes(item.identifier);
        map.set(item.identifier, {
            identifier: item.identifier, name: typeof item.name === 'string' ? item.name : item.identifier,
            role, content: item.content ?? '', marker,
            injection_position: numeric(item.injection_position ?? 0, 'injection_position', 0, 1, true),
            injection_depth: numeric(item.injection_depth ?? 4, 'injection_depth', 0, 10000, true),
            injection_order: numeric(item.injection_order ?? 100, 'injection_order', 0, 10000, true),
            injection_trigger: [...(item.injection_trigger ?? [])],
        });
    }
    for (const [key, identifier] of Object.entries(LEGACY)) {
        if (source[key] === undefined) continue;
        if (typeof source[key] !== 'string') fail(`${key} 必須是字串。`);
        if (!map.has(identifier)) map.set(identifier, { identifier, role: 'system', content: '', marker: false });
        // Also preserve intentionally empty old prompts; never insert ST's RP default.
        map.get(identifier).content = source[key];
    }
    let orders = source.prompt_order;
    if (orders === undefined || orders === null || (Array.isArray(orders) && !orders.length)) {
        orders = [{ character_id: GLOBAL_ORDER, order: DEFAULT_ORDER.map(identifier => ({ identifier, enabled: identifier !== 'enhanceDefinitions' })) }];
        warnings.push('未提供 prompt_order，使用 ST 內建順序；未列入順序的自訂提示詞不會自動啟用。');
    } else if (Array.isArray(orders) && orders.every(entry => plain(entry) && typeof entry.identifier === 'string')) {
        // Prompt Manager exports its active order as a flat list.
        orders = [{ character_id: GLOBAL_ORDER, order: orders }];
    }
    if (!Array.isArray(orders)) fail('prompt_order 必須是陣列。');
    const seenOrders = new Set();
    const prompt_order = orders.map(entry => {
        if (!plain(entry) || !['string', 'number'].includes(typeof entry.character_id)) fail('prompt_order 缺少 character_id。');
        const id = String(entry.character_id);
        if (!id || seenOrders.has(id)) fail('character_id 空白或重複。');
        seenOrders.add(id);
        return { character_id: id, order: normalizeOrder(entry.order) };
    });
    const missing = new Set(prompt_order.flatMap(entry => entry.order.map(item => item.identifier)).filter(id => !map.has(id)));
    for (const id of missing) {
        if (MARKERS.includes(id) || DEFAULT_ORDER.includes(id)) {
            map.set(id, { identifier: id, role: 'system', content: '', marker: MARKERS.includes(id) });
        } else warnings.push(`順序引用不存在的提示詞：${id}（略過）。`);
    }
    const preset = { prompts: [...map.values()], prompt_order, ...presetSampling(source) };
    if (source.openai_max_tokens !== undefined) preset.openai_max_tokens = numeric(source.openai_max_tokens, 'openai_max_tokens', 1, 1000000, true);
    for (const key of FORMATS) {
        if (source[key] === undefined) continue;
        if (typeof source[key] !== 'string') fail(`${key} 必須是字串。`);
        preset[key] = source[key];
    }
    if (preset.prompts.some(item => item.marker && (!MARKERS.includes(item.identifier) || item.identifier.startsWith('worldInfo')))) {
        warnings.push('世界書與未知 marker 不在獨立請求中展開，會略過；角色、Persona、範例與聊天 marker 可用。');
    }
    if (source.extensions || source.extension_settings || source.regex_scripts) warnings.push('預設附帶的擴展／Regex／腳本設定不匯入、不執行。');
    const omitted = ['top_k', 'top_a', 'min_p', 'repetition_penalty', 'reasoning_effort', 'verbosity',
        'bias_preset_selected', 'assistant_prefill', 'use_sysprompt', 'squash_system_messages', 'names_behavior',
        'enable_web_search', 'function_calling', 'request_images', 'n', 'openai_max_context']
        .filter(key => source[key] !== undefined);
    if (omitted.length) warnings.push(`未套用的非通用設定：${omitted.join(', ')}。`);
    const orderId = seenOrders.has(GLOBAL_ORDER) ? GLOBAL_ORDER : prompt_order.length === 1 ? prompt_order[0].character_id : '';
    if (!orderId) warnings.push('包含多組非全域順序，請先選擇要使用的 character_id。');
    return { preset, orderId, warnings: [...new Set(warnings)] };
}

export function getPresetOrder(preset, orderId) {
    const id = orderId || (preset.prompt_order.some(entry => String(entry.character_id) === GLOBAL_ORDER) ? GLOBAL_ORDER
        : preset.prompt_order.length === 1 ? String(preset.prompt_order[0].character_id) : '');
    const order = preset.prompt_order.find(entry => String(entry.character_id) === id)?.order;
    if (!order) fail('請選擇有效的預設提示詞順序（character_id）。');
    return order;
}

/** ST injects into reverse history, then reverses it: order asc, assistant/user/system. */
function injectHistory(history, injections) {
    const messages = history.map(message => ({ ...message }));
    const depths = [...new Set(injections.map(item => item.injection_depth))].sort((a, b) => b - a);
    for (const depth of depths) {
        const atDepth = injections.filter(item => item.injection_depth === depth);
        const orders = [...new Set(atDepth.map(item => item.injection_order))].sort((a, b) => a - b);
        const grouped = [];
        for (const order of orders) {
            for (const role of ['assistant', 'user', 'system']) {
                const content = atDepth.filter(item => item.injection_order === order && item.role === role)
                    .map(item => item.content).join('\n');
                if (content.trim()) grouped.push({ role, content: content.trim() });
            }
        }
        // Depth counts original messages, not injections already inserted.
        // Deeper injections precede this original-history boundary.
        const index = Math.max(0, history.length - depth);
        const before = injections.filter(item => item.injection_depth > depth);
        const priorCount = new Set(before.map(item => `${item.injection_depth}:${item.injection_order}:${item.role}`)).size;
        messages.splice(index + priorCount, 0, ...grouped);
    }
    return messages;
}

export function exampleMessages(text, { char = '', user = '', groupNames = [], expand = value => value, separator = '' } = {}) {
    const result = [];
    for (const block of String(text || '').split(/<START>/gi).filter(part => part.trim())) {
        const messages = [];
        for (const line of block.split('\n')) {
            const speaker = [user, char, ...groupNames].filter(Boolean).find(name => line.startsWith(`${name}:`));
            const role = speaker ? speaker === user ? 'user' : 'assistant' : null;
            if (role) messages.push({ role, content: groupNames.length ? line.trim() : line.slice(speaker.length + 1).trim() });
            else if (messages.length) messages[messages.length - 1].content += `\n${line}`;
        }
        if (messages.length && separator) result.push({ role: 'system', content: expand(separator) });
        result.push(...messages.filter(message => message.content.trim()));
    }
    return result;
}

/** Read raw card fields; ST's card getter would expand using the CURRENT speaker. */
export function presetCardContext(context, message) {
    const characters = context.characters ?? [];
    const character = context.groupId && !message.is_user
        ? characters.find(card => message.original_avatar && card.avatar === message.original_avatar)
            ?? characters.find(card => card.name === message.name)
        : characters[context.characterId];
    const char = context.groupId && !message.is_user ? message.name : character?.name ?? context.name2;
    return { char: String(char ?? ''), user: String(context.name1 ?? ''), fields: {
        description: String(character?.description ?? character?.data?.description ?? ''),
        personality: String(character?.personality ?? character?.data?.personality ?? ''),
        scenario: String(context.chatMetadata?.scenario || character?.scenario || character?.data?.scenario || ''),
        mesExamples: String(context.chatMetadata?.mes_example || character?.mes_example || character?.data?.mes_example || ''),
        persona: String(context.powerUserSettings?.persona_description ?? ''),
    } };
}

/** Scope history to the clicked message, never to the end of the current chat. */
export function collectPresetHistory(chat, messageId, depth, isGroup = false) {
    const limit = Math.min(50, Math.max(0, Math.floor(Number(depth) || 0)));
    const messages = chat.slice(0, messageId + 1).filter(message => message && !message.is_system && String(message.mes ?? '').trim());
    return messages.slice(-(limit + 1)).map(message => ({
        role: message.is_user ? 'user' : 'assistant',
        content: `${isGroup && message.name ? `${message.name}: ` : ''}${String(message.mes).trim()}`,
    }));
}

/** Build only the independent prompt request, not a full normal RP generation. */
export function buildPresetMessages(preset, { orderId = '', history = [], fields = {}, expand = value => value,
    char = '', user = '', isGroup = false, groupNames = [] } = {}) {
    const order = getPresetOrder(preset, orderId);
    const byId = new Map(preset.prompts.map(item => [item.identifier, item]));
    const enabled = order.filter(entry => entry.enabled === true).map(entry => byId.get(entry.identifier)).filter(Boolean)
        .filter(item => !item.injection_trigger?.length || item.injection_trigger.includes('quiet'));
    const result = [], injections = [];
    let historyIndex = -1, phiIndex = -1;
    for (const item of enabled) {
        if (item.identifier === 'jailbreak') phiIndex = result.length;
        if (item.identifier === 'chatHistory') {
            historyIndex = result.length;
            result.push({ history: true });
            continue;
        }
        if (item.identifier === 'dialogueExamples') {
            result.push(...exampleMessages(fields.mesExamples, { char, user, groupNames, expand, separator: preset.new_example_chat_prompt }));
            continue;
        }
        let content;
        if (item.marker) {
            const field = { charDescription: 'description', charPersonality: 'personality', scenario: 'scenario', personaDescription: 'persona' }[item.identifier];
            if (!field) continue;
            content = String(fields[field] ?? '');
            const format = item.identifier === 'charPersonality' ? preset.personality_format : item.identifier === 'scenario' ? preset.scenario_format : '';
            if (content && format) content = expand(format);
        } else content = expand(item.content || '');
        if (!content.trim()) continue;
        const message = { role: item.role || 'system', content: content.trim() };
        if (item.injection_position === 1) injections.push({ ...item, ...message });
        else result.push(message);
    }
    // Partial prompt exports sometimes omit chatHistory entirely. Supply the
    // selected scene, but never re-enable an explicitly disabled history marker.
    if (!order.some(entry => entry.identifier === 'chatHistory')) {
        historyIndex = phiIndex < 0 ? result.length : phiIndex;
        result.splice(historyIndex, 0, { history: true });
    }
    if (historyIndex >= 0) {
        const chat = injectHistory(history, injections);
        const newChat = isGroup ? preset.new_group_chat_prompt : preset.new_chat_prompt;
        if (newChat?.trim()) chat.unshift({ role: 'system', content: expand(newChat) });
        result.splice(historyIndex, 1, ...chat);
    }
    if (!result.length) fail('此順序在 quiet 生成下沒有任何可送出的訊息。');
    return result;
}

/** Safe transport adapter; legacy callers retain their original options. */
export async function sendPromptRequest({ settings, messages, maxTokens, signal, preset = null, context, manualLlm }) {
    const parameters = preset ? presetSampling(preset) : {};
    if (settings.promptConnectionMode === 'manual') return manualLlm.send(settings, messages, maxTokens, signal, parameters);
    const service = context.ConnectionManagerRequestService;
    if (preset) {
        const profile = context.extensionSettings?.connectionManager?.profiles?.find(item => item.id === settings.profileId);
        if (context.CONNECT_API_MAP?.[profile?.api]?.selected !== 'openai') fail('Chat Completion 預設需要 Chat Completion 連線，或手動 OpenAI 相容 API；Text Completion 請繼續使用原模板模式。');
        // This is the user's TRUSTED connection preset, not the imported JSON.
        // ST processRequest uses it for transport (custom headers, Vertex auth,
        // etc.) and sampling only; it does not assemble prompts/prompt_order.
        // Explicit image-prompt samplers override it via the fifth argument.
        return service.sendRequest(settings.profileId, messages, maxTokens,
            { stream: false, signal, extractData: true, includePreset: true, includeInstruct: false }, parameters);
    }
    return service.sendRequest(settings.profileId, messages, maxTokens,
        { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true });
}
