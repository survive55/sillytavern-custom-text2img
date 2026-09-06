import { boundedText } from './preset-regex.js';

/** An allowlisted macro interpreter. No ST services, storage, eval or callbacks. */
export function createPresetMacros({ values = {}, variables = [], globals = [], picks = [], random = Math.random } = {}) {
    const local = new Map(variables), global = new Map(globals), choices = new Map(picks), warnings = new Set();
    let operations = 0;
    function evaluate(body, transform, depth) {
        const separator = body.indexOf('::');
        const name = (separator < 0 ? body : body.slice(0, separator)).trim().toLowerCase();
        const rest = separator < 0 ? '' : body.slice(separator + 2);
        if (body.trimStart().startsWith('//')) return '';
        if (name === 'trim' || name === 'noop') return '';
        if (name === 'newline') return '\n';
        if (/^(set|get|add|inc|dec)(global)?var$/.test(name)) {
            const store = name.includes('global') ? global : local;
            const split = rest.indexOf('::');
            const key = expand(split < 0 ? rest : rest.slice(0, split), value => value, depth + 1).trim();
            const value = split < 0 ? '' : expand(rest.slice(split + 2), value => value, depth + 1);
            if (name.startsWith('set')) { store.set(key, value); return ''; }
            if (name.startsWith('get')) return transform(String(store.get(key) ?? ''));
            let next;
            if (name.startsWith('add')) {
                const before = store.get(key) ?? 0;
                next = String(before).trim() !== '' && value.trim() !== '' && Number.isFinite(Number(before)) && Number.isFinite(Number(value))
                    ? Number(before) + Number(value) : String(before) + value;
            } else next = (Number(store.get(key)) || 0) + (name.startsWith('inc') ? 1 : -1);
            store.set(key, boundedText(next));
            return name.startsWith('add') ? '' : transform(String(next));
        }
        if (name === 'random' || name === 'pick') {
            const parts = rest.includes('::') ? rest.split('::') : rest.split(',');
            const key = body;
            let index = name === 'pick' ? choices.get(key) : undefined;
            if (index === undefined) { index = Math.min(parts.length - 1, Math.floor(random() * parts.length)); if (name === 'pick') choices.set(key, index); }
            return transform(expand(parts[index]?.trim() ?? '', value => value, depth + 1));
        }
        if (/^roll(?::|$)/.test(name)) {
            const dice = (rest || name.slice(5)).match(/^(\d{0,3})d(\d{1,6})([+-]\d+)?$/i);
            if (dice && Number(dice[1] || 1) <= 100 && Number(dice[2]) > 0) {
                let result = Number(dice[3] || 0);
                for (let i = 0; i < Number(dice[1] || 1); i++) result += 1 + Math.floor(random() * Number(dice[2]));
                return transform(String(result));
            }
        }
        const entry = Object.entries(values).find(([key]) => key.toLowerCase() === name);
        if (entry && separator < 0) return transform(String(entry[1] ?? ''));
        const date = new Date();
        const dates = { date: date.toLocaleDateString(), time: date.toLocaleTimeString(), isodate: date.toISOString().slice(0, 10), isotime: date.toTimeString().slice(0, 5) };
        if (Object.hasOwn(dates, name)) return transform(dates[name]);
        warnings.add(`未支援巨集 {{${name}}}：保留為文字，不呼叫主聊天巨集或第三方腳本。`);
        return `{{${body}}}`;
    }
    function expand(input, transform = value => value, depth = 0) {
        if (depth > 16) throw new Error('獨立預設：巨集巢狀超過 16 層。');
        let source = boundedText(input), output = '', cursor = 0;
        // Comments must not execute variable assignments inside them.
        source = source.replace(/{{\/\/[\s\S]*?}}/g, '').replace(/(?:\r?\n)*{{trim}}(?:\r?\n)*/gi, '');
        while (cursor < source.length) {
            const start = source.indexOf('{{', cursor);
            if (start < 0) { output += source.slice(cursor); break; }
            output += source.slice(cursor, start);
            let end = start + 2, nesting = 1;
            for (; end < source.length && nesting; end++) {
                if (source.slice(end, end + 2) === '{{') { nesting++; end++; }
                else if (source.slice(end, end + 2) === '}}') { nesting--; if (nesting) end++; else break; }
            }
            if (nesting) { output += source.slice(start); break; }
            if (++operations > 20000) throw new Error('獨立預設：巨集操作次數超過上限。');
            output += evaluate(source.slice(start + 2, end), transform, depth);
            boundedText(output);
            cursor = end + 2;
        }
        return boundedText(output);
    }
    return { expand, values, warnings, snapshot: () => ({ variables: [...local], globals: [...global], picks: [...choices] }) };
}
