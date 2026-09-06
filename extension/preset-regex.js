/** Pure, request-scoped Regex support. Never consult ST's active/global rules. */
export const MAX_RUNTIME_TEXT = 1024 * 1024;
export function boundedText(value) {
    const text = String(value ?? '');
    if (text.length > MAX_RUNTIME_TEXT) throw new Error('獨立預設：文字超過 1 MiB 安全上限。');
    return text;
}
export function compileRegex(value) {
    const literal = String(value).match(/^\/(.*)\/([dgimsuvy]*)$/s);
    return literal ? new RegExp(literal[1], literal[2]) : new RegExp(value);
}
export function normalizePresetRegex(source, warnings) {
    const raw = source.extensions?.regex_scripts;
    if (source.extensions?.SPreset?.RegexBinding?.regexes?.length) warnings.push('只採用原生 extensions.regex_scripts；SPreset 綁定不合併、不重複執行。');
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > 200) throw new Error('LLM 預設：regex_scripts 必須是最多 200 條的陣列。');
    return raw.map((rule, index) => {
        const fail = message => { throw new Error(`LLM 預設：正則 #${index + 1} ${message}`); };
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) fail('不是有效物件。');
        if (typeof rule.findRegex !== 'string' || typeof rule.replaceString !== 'string') fail('需提供 findRegex / replaceString 字串。');
        if (!Array.isArray(rule.placement) || rule.placement.some(value => !Number.isInteger(value))) fail('placement 必須是整數陣列。');
        if (rule.trimStrings !== undefined && (!Array.isArray(rule.trimStrings) || rule.trimStrings.some(value => typeof value !== 'string'))) fail('trimStrings 必須是字串陣列。');
        const result = { id: String(rule.id ?? `regex-${index}`), scriptName: String(rule.scriptName ?? `Regex ${index + 1}`),
            findRegex: boundedText(rule.findRegex), replaceString: boundedText(rule.replaceString),
            placement: [...rule.placement], trimStrings: [...(rule.trimStrings ?? [])] };
        for (const key of ['disabled', 'markdownOnly', 'promptOnly', 'runOnEdit']) {
            if (rule[key] !== undefined && typeof rule[key] !== 'boolean') fail(`${key} 必須是布林值。`);
            result[key] = rule[key] === true;
        }
        result.substituteRegex = rule.substituteRegex ?? 0;
        if (![0, 1, 2].includes(result.substituteRegex)) fail('substituteRegex 必須是 0、1 或 2。');
        for (const key of ['minDepth', 'maxDepth']) {
            const value = rule[key] ?? null;
            if (value !== null && (!Number.isSafeInteger(value) || value < -1 || value > 10000)) fail(`${key} 超出範圍。`);
            result[key] = value;
        }
        if (result.substituteRegex === 0 && result.findRegex) {
            try { compileRegex(result.findRegex); } catch { fail('findRegex 語法無效。'); }
        }
        if (result.placement.some(value => ![1, 2].includes(value))) warnings.push('独立正則只處理 User Input / AI Output；世界書、指令、推理來源不執行。');
        return result;
    });
}
const escapeRegex = value => String(value).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&').replace(/\n/g, '\\n').replace(/\r/g, '\\r');

/** Called in a disposable Worker in production: regex execution can time out. */
export function applyPresetRegex(text, rules, { role, stage, depth = 0, expand = value => value } = {}) {
    let output = boundedText(text);
    const placement = role === 'user' ? 1 : role === 'assistant' ? 2 : -1;
    for (const rule of rules) {
        if (rule.disabled || !rule.findRegex || !output || !rule.placement.includes(placement)) continue;
        const applies = stage === 'prompt' ? rule.promptOnly : stage === 'display' ? rule.markdownOnly : !rule.promptOnly && !rule.markdownOnly;
        if (!applies || (rule.minDepth !== null && rule.minDepth >= -1 && depth < rule.minDepth)
            || (rule.maxDepth !== null && rule.maxDepth >= 0 && depth > rule.maxDepth)) continue;
        const expression = rule.substituteRegex === 0 ? rule.findRegex
            : expand(rule.findRegex, rule.substituteRegex === 2 ? escapeRegex : value => value);
        let regex;
        try { regex = compileRegex(expression); } catch { throw new Error(`獨立正則「${rule.scriptName}」巨集展開後的語法無效。`); }
        output = boundedText(output.replace(regex, (...args) => {
            const named = typeof args.at(-1) === 'object' ? args.at(-1) : {};
            const groupCount = args.length - (typeof args.at(-1) === 'object' ? 3 : 2);
            const values = new Map();
            const nonce = `\uE000capture-${Math.random()}-`;
            let replacement = rule.replaceString.replace(/{{match}}/gi, '$0').replace(/\$(\d+)|\$<([^>]+)>/g, (_, number, name) => {
                let value = String(number !== undefined ? Number(number) < groupCount ? args[Number(number)] ?? '' : '' : named[name] ?? '');
                for (const trim of rule.trimStrings) value = value.split(expand(trim)).join('');
                const token = `${nonce}${values.size}\uE001`;
                values.set(token, value);
                return token;
            });
            // Captured chat text is data, not an opportunity to execute macros.
            replacement = expand(replacement);
            for (const [token, value] of values) replacement = replacement.split(token).join(value);
            return boundedText(replacement);
        }));
    }
    return output;
}
