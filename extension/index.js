/**
 * Custom Text2Img Illustrator — SillyTavern UI extension.
 *
 * Adds a per-message "生成插圖" button. Clicking it:
 *   1. reads that message's text (plus optional history / character description),
 *   2. asks an LLM — through an independent Connection Manager profile, never the
 *      user's main chat preset — to turn it into an image prompt,
 *   3. calls NovelAI directly in the browser, or submits/polls a job through the
 *      control panel's cookie-free browser API (no ST server plugin required),
 *   4. stores the resulting image(s) in SillyTavern and attaches them to that very
 *      message via `message.extra.media` (native gallery rendering).
 *
 * Nothing on the image server is written: presets are read-only, and the
 * workflow is only driven through the existing generate endpoint.
 */

// ST imports must not depend on whether the UI is at the repo root or in extension/.
import { saveBase64AsFile } from '/scripts/utils.js';
import { MEDIA_DISPLAY, MEDIA_SOURCE, MEDIA_TYPE, SCROLL_BEHAVIOR } from '/scripts/constants.js';
import { generateWithPolling } from './generation.js';
import { PROVIDER_DEFAULTS, migrateSettings, providerConnection, buildNovelPayload } from './providers.js';
import { createPanelClient } from './panel.js';
import { createNovelAI } from './novelai.js';
import { encryptToken, decryptToken } from './token-vault.js';
import { normalizeToken } from './http.js';

// Works for both a GitHub clone (extension/) and the flat install-ui deployment.
const EXTENSION_FOLDER = new URL('.', import.meta.url).pathname
    .replace(/^\/scripts\/extensions\//, '').replace(/\/$/, '');
const novelai = createNovelAI();
let novelSessionToken = '', unlockedVaultFingerprint = '', novelSessionMode = '';
let cachedPanel = null, cachedPanelKey = '';
const BUTTON_CLASS = 'cmi_message_gen';
const BUSY_CLASS = 'cmi_busy';
const LOG_PREFIX = '[SillyTavernCustomText2Img]';

const DEFAULT_SYSTEM_PROMPT = [
    'You are an expert prompt engineer for anime-style image models (NovelAI Diffusion / Illustrious / SDXL).',
    'Turn the roleplay excerpt you are given into ONE image prompt: a comma-separated list of concise, English, Danbooru-style tags.',
    'Cover, in this order: subject count (1girl / 1boy / 2girls ...), the character\'s appearance (hair, eyes, body, notable features), clothing, pose and action, facial expression, setting and background, lighting and mood, camera angle / framing.',
    'Describe only what is visible in the scene; do not narrate, do not include names, dialogue, sounds, or a negative prompt.',
    'Output ONLY the tag list on a single line — no quotes, no code fences, no explanations.',
].join('\n');

const DEFAULT_USER_TEMPLATE = [
    'Character: {{char}}',
    'Character description:',
    '{{description}}',
    '',
    'Earlier context:',
    '{{history}}',
    '',
    'Scene to illustrate (latest message):',
    '{{message}}',
    '',
    'Write the image prompt now.',
].join('\n');

const defaultSettings = Object.freeze({
    enabled: true,
    baseUrl: 'http://127.0.0.1:8800',
    password: '',
    panelPreset: '',
    usePresetPositive: true,
    usePresetNegative: true,
    profileId: '',
    maxTokens: 400,
    historyDepth: 2,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userTemplate: DEFAULT_USER_TEMPLATE,
    reviewPrompt: false,
    negativePrompt: '',
    width: '',
    height: '',
    batchSize: 1,
    seed: '',
    advancedOverrides: '',
    ...PROVIDER_DEFAULTS,
});

/** @type {WeakMap<HTMLElement, AbortController>} */
const activeJobs = new WeakMap();

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

function getSettings() {
    const { extensionSettings } = SillyTavern.getContext();
    const { settings, changed } = migrateSettings(extensionSettings, defaultSettings);
    if (changed) saveSettings();
    return settings;
}

function saveSettings() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// ---------------------------------------------------------------------------
// Direct browser clients; credentials never cross provider boundaries.
// ---------------------------------------------------------------------------

function getPanelClient(connection = getSettings()) {
    const key = JSON.stringify([connection.baseUrl, connection.password]);
    if (!cachedPanel || key !== cachedPanelKey) {
        cachedPanel = createPanelClient({ baseUrl: connection.baseUrl, password: connection.password });
        cachedPanelKey = key;
    }
    return cachedPanel;
}

function clearUnlockedToken() {
    novelSessionToken = '';
    unlockedVaultFingerprint = '';
    novelSessionMode = '';
}

function unlockedToken() {
    if (unlockedVaultFingerprint !== JSON.stringify(getSettings().novelVault)) clearUnlockedToken();
    if (!novelSessionToken) throw new Error('請先儲存並解鎖 NovelAI Token，或選擇「僅本次使用」。');
    return novelSessionToken;
}

function createImageClient(plan) {
    return plan.provider === 'novelai' ? novelai.client(unlockedToken()) : getPanelClient(plan.connection);
}

// ---------------------------------------------------------------------------
// Prompt generation (independent connection profile)
// ---------------------------------------------------------------------------

/**
 * @returns {import('../../connection-manager/index.js').ConnectionProfile[]}
 */
function listProfiles() {
    const context = SillyTavern.getContext();
    const profiles = context.extensionSettings?.connectionManager?.profiles ?? [];
    if (!Array.isArray(profiles)) return [];
    return profiles.filter((profile) => {
        // ST 1.14's checker can throw for a provider introduced in a newer ST
        // release. One incompatible/imported profile must not break the UI.
        try {
            return context.ConnectionManagerRequestService?.isProfileSupported(profile) ?? false;
        } catch {
            return false;
        }
    });
}

/**
 * Collect the texts of up to `depth` visible messages preceding `messageId`.
 * @param {number} messageId
 * @param {number} depth
 */
function collectHistory(messageId, depth) {
    const { chat } = SillyTavern.getContext();
    if (!depth || depth <= 0) return '';
    const lines = [];
    for (let i = messageId - 1; i >= 0 && lines.length < depth; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        const text = String(message.mes ?? '').trim();
        if (!text) continue;
        lines.unshift(`${message.name}: ${text}`);
    }
    return lines.join('\n\n');
}

/**
 * Resolve the character description for the message author.
 * @param {object} message
 */
function resolveDescription(message) {
    const context = SillyTavern.getContext();
    try {
        if (!context.groupId && context.characterId !== undefined) {
            const fields = context.getCharacterCardFields();
            return String(fields?.description ?? '').trim();
        }
        const character = context.characters.find((c) => c.name === message.name);
        return String(character?.description ?? '').trim();
    } catch (error) {
        console.warn(LOG_PREFIX, 'Could not resolve character description', error);
        return '';
    }
}

/**
 * Replace extension-specific placeholders after the regular ST macros ran, so
 * that macro-looking text inside the chat message is never expanded.
 * @param {string} template
 * @param {Record<string, string>} values
 */
function fillTemplate(template, values) {
    const context = SillyTavern.getContext();
    const tokens = {};
    let text = template;
    for (const key of Object.keys(values)) {
        const token = `\uE000CMI_${key.toUpperCase()}\uE000`;
        tokens[token] = values[key];
        text = text.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), token);
    }
    text = context.substituteParamsExtended(text);
    for (const [token, value] of Object.entries(tokens)) {
        text = text.split(token).join(value);
    }
    return text;
}

/**
 * Normalize the LLM output into a single-line tag list.
 * @param {string} raw
 */
function cleanPrompt(raw) {
    let text = String(raw ?? '');
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/```[a-z]*\n?([\s\S]*?)```/gi, '$1');
    text = text.replace(/^\s*(?:image\s+)?prompt\s*[:：]\s*/i, '');
    text = text.replace(/^["'“”`\s]+|["'“”`\s]+$/g, '');
    text = text.replace(/\s*\n+\s*/g, ', ');
    text = text.replace(/\s{2,}/g, ' ');
    text = text.replace(/(\s*,\s*){2,}/g, ', ');
    return text.trim().replace(/^,\s*|,\s*$/g, '');
}

/**
 * Ask the configured connection profile for an image prompt.
 * @param {number} messageId
 * @param {object} message
 * @param {AbortSignal} signal
 * @returns {Promise<string>}
 */
async function generatePrompt(messageId, message, signal, settings = getSettings()) {
    const context = SillyTavern.getContext();
    if (!settings.profileId) {
        throw new Error('尚未選擇提示詞生成用的連線設定檔（擴展設定 → 提示詞生成）。');
    }
    if (!listProfiles().some((p) => p.id === settings.profileId)) {
        throw new Error('所選的連線設定檔已不存在或不受支援，請重新選擇。');
    }

    const values = {
        message: String(message.mes ?? '').trim(),
        history: collectHistory(messageId, Number(settings.historyDepth) || 0),
        description: resolveDescription(message),
    };
    const systemPrompt = fillTemplate(settings.systemPrompt, values).trim();
    const userPrompt = fillTemplate(settings.userTemplate, values).trim();

    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const maxTokens = Math.max(16, Number(settings.maxTokens) || defaultSettings.maxTokens);
    const result = await context.ConnectionManagerRequestService.sendRequest(
        settings.profileId,
        messages,
        maxTokens,
        { stream: false, signal, extractData: true, includePreset: true, includeInstruct: true },
    );

    const content = typeof result === 'string' ? result : result?.content;
    const prompt = cleanPrompt(content);
    if (!prompt) {
        throw new Error('提示詞生成模型回傳了空白內容。');
    }
    return prompt;
}

/**
 * Let the user review / edit the prompt before generating.
 * @param {string} prompt
 * @returns {Promise<string | null>} edited prompt or null when cancelled
 */
async function reviewPrompt(prompt, provider) {
    const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
    const destination = provider === 'novelai' ? 'NovelAI 官方 API（可能消耗 Anlas）' : 'ComfyUI on Modal';
    const result = await callGenericPopup(
        `<h3>檢視 / 編輯圖片提示詞</h3><p>確認後將送往 ${destination} 生成圖片。</p>`,
        POPUP_TYPE.INPUT,
        prompt,
        { rows: 8, okButton: '生成圖片', cancelButton: '取消', wide: true, large: false },
    );
    if (result === null || result === false || result === undefined) return null;
    const text = String(result).trim();
    return text || null;
}

// ---------------------------------------------------------------------------
// Image generation payload
// ---------------------------------------------------------------------------

/**
 * @param {string} text
 * @returns {object}
 */
function parseAdvancedOverrides(text) {
    const trimmed = String(text ?? '').trim();
    if (!trimmed) return {};
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('進階覆寫必須是 JSON 物件');
    }
    return parsed;
}

/**
 * @param {string} prompt
 * @param {object | null} preset
 * @returns {object}
 */
function buildGeneratePayload(prompt, preset, settings = getSettings()) {
    const payload = {};

    const presetPositive = String(preset?.prompts?.positive ?? '').trim();
    const presetNegative = String(preset?.prompts?.negative ?? '').trim();

    payload.prompt_text = settings.usePresetPositive && presetPositive
        ? `${presetPositive.replace(/[,\s]+$/, '')}, ${prompt}`
        : prompt;

    const negative = String(settings.negativePrompt ?? '').trim();
    if (negative) {
        payload.negative_text = negative;
    } else if (settings.usePresetNegative && presetNegative) {
        payload.negative_text = presetNegative;
    }

    if (preset) {
        if (preset.panel_values && typeof preset.panel_values === 'object') payload.panel_values = preset.panel_values;
        if (preset.group_states && typeof preset.group_states === 'object') payload.group_states = preset.group_states;
        if (Array.isArray(preset.loras)) payload.loras = preset.loras;
        if (preset.resolution?.width) payload.width = Number(preset.resolution.width);
        if (preset.resolution?.height) payload.height = Number(preset.resolution.height);
        if (preset.batch_size) payload.batch_size = Number(preset.batch_size);
    }

    const width = Number(settings.width);
    const height = Number(settings.height);
    const batch = Number(settings.batchSize);
    if (width > 0) payload.width = width;
    if (height > 0) payload.height = height;
    if (batch > 0) payload.batch_size = batch;

    const seed = String(settings.seed ?? '').trim();
    if (seed) payload.seed = seed;

    payload.filename_prefix = 'sillytavern';

    const overrides = parseAdvancedOverrides(settings.advancedOverrides);
    Object.assign(payload, overrides);
    return payload;
}

/**
 * Load the selected panel preset from the image server (read-only).
 * @param {AbortSignal} signal
 * @returns {Promise<object | null>}
 */
async function loadSelectedPreset(signal, settings = getSettings(), client = getPanelClient(settings)) {
    const name = String(settings.panelPreset ?? '').trim();
    if (!name) return null;
    return client.preset(name, signal);
}

// ---------------------------------------------------------------------------
// Tunnel-safe panel jobs and page-owned NovelAI jobs
// ---------------------------------------------------------------------------

/**
 * @param {object} payload
 * @param {AbortSignal} signal
 * @param {(event: any) => void} onEvent
 * @returns {Promise<{ images: string[], seed: string | null, generationId: number | null }>}
 */
async function generateImages(payload, signal, onEvent, client) {
    // This same frozen client is used for submit, polling AND image retrieval.
    return generateWithPolling({
        submit: (requestSignal) => client.submit(payload, requestSignal),
        poll: (jobId, after, requestSignal) => client.poll(jobId, after, requestSignal),
        onEvent,
        signal,
    });
}

/**
 * Human-readable progress line for a generation event.
 * @param {any} event
 */
function describeEvent(event) {
    switch (event?.type) {
        case 'accepted': return event.provider === 'novelai' ? 'NovelAI 任務已接受，等待官方生圖回應…' : '請求已接受，準備送往 ComfyUI…';
        case 'queued': return event.position !== undefined ? `排隊中（前方 ${event.position} 個任務）…` : '已進入 ComfyUI 佇列…';
        case 'warming': return `GPU 容器喚醒中（${event.stage ?? ''} ${Math.round(event.elapsed_seconds ?? 0)}s）…`;
        case 'submitting': return `送出工作流（${event.nodes ?? '?'} 個節點）…`;
        case 'progress': {
            const value = Number(event.value ?? 0);
            const max = Number(event.max ?? 0);
            return max > 0 ? `取樣中 ${value}/${max}…` : '取樣中…';
        }
        case 'node': return event.node ? `執行節點 ${event.node}…` : '執行中…';
        case 'image': return '圖片已產生，下載中…';
        case 'done': return '完成，正在存入聊天…';
        case 'reconnecting': return event.message;
        default: return null;
    }
}

// ---------------------------------------------------------------------------
// Progress toast
// ---------------------------------------------------------------------------

/**
 * @param {string} title
 * @param {() => void} onAbort Called when the user clicks the toast.
 */
function createProgressToast(title, onAbort) {
    const HINT = '（點擊停止等待；已送出的生圖仍會在伺服器完成）';
    const $toast = toastr.info(`準備中… ${HINT}`, title, {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        closeButton: false,
        progressBar: false,
        onclick: () => onAbort?.(),
    });
    return {
        update(text) {
            if ($toast && text) $toast.find('.toast-message').text(`${text} ${HINT}`);
        },
        close() {
            if ($toast) toastr.clear($toast);
        },
    };
}

// ---------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------

/**
 * Generate an illustration for the given message and attach it.
 * @param {JQuery<HTMLElement>} $button
 */
async function onMessageButtonClick($button) {
    const buttonEl = $button.get(0);
    if (!buttonEl) return;
    const running = activeJobs.get(buttonEl);
    if (running) {
        running.abort('Aborted by user');
        return;
    }
    const context = SillyTavern.getContext();
    const settings = structuredClone(getSettings());
    if (!settings.enabled) return;
    const plan = providerConnection(settings);
    const novel = settings.provider === 'novelai';
    const title = `Custom Text2Img · ${novel ? 'NovelAI' : 'ComfyUI / Modal'}`;
    const messageId = Number($button.closest('.mes').attr('mesid'));
    const message = context.chat[messageId];
    if (!message || !String(message.mes ?? '').trim()) {
        toastr.warning('找不到樓層文字。', title);
        return;
    }
    if (!novel && (!settings.baseUrl.trim() || !settings.password)) {
        toastr.error('請先填寫 ComfyUI 控制面板的 Base URL 與密碼。', title);
        return;
    }

    const controller = new AbortController();
    const { signal } = controller;
    activeJobs.set(buttonEl, controller);
    $button.addClass(BUSY_CLASS).addClass('fa-fade');
    const chatIdAtStart = context.getCurrentChatId();
    const textAtStart = message.mes;
    const swipeAtStart = message.swipe_id;
    const characterName = context.groupId
        ? (context.groups?.find(g => g.id === context.groupId)?.name || 'group')
        : (context.name2 || 'character');
    const toast = createProgressToast(title, () => controller.abort('Aborted by user'));

    try {
        const client = createImageClient(plan);
        await client.prepare(signal);
        signal.throwIfAborted();
        toast.update('正在請 AI 撰寫圖片提示詞…');
        let prompt = await generatePrompt(messageId, message, signal, settings);
        if (settings.reviewPrompt) {
            toast.update('等待檢視提示詞…');
            const edited = await reviewPrompt(prompt, settings.provider);
            if (edited === null) return;
            prompt = edited;
        }
        signal.throwIfAborted();
        let payload;
        if (novel) {
            payload = buildNovelPayload(prompt, settings);
        } else {
            toast.update('讀取面板預設組合…');
            payload = buildGeneratePayload(prompt, await loadSelectedPreset(signal, settings, client), settings);
        }
        toast.update('送出產圖請求…');
        const result = await generateImages(payload, signal, (event) => {
            const text = describeEvent(event);
            if (text) toast.update(text);
        }, client);
        if (!result.images.length) throw new Error('圖片伺服器沒有回傳任何圖片。');

        toast.update(`下載 ${result.images.length} 張圖片…`);
        const saved = [];
        const seeds = [];
        for (const path of result.images) {
            signal.throwIfAborted();
            const file = await client.output(path, signal);
            const filename = `${characterName}_${context.humanizedDateTime()}_${saved.length}`;
            const url = await saveBase64AsFile(file.data, characterName, filename, file.format || 'png');
            saved.push(url);
            seeds.push(file.seed ?? (saved.length === 1 || !novel ? result.seed : null));
        }
        signal.throwIfAborted();
        const current = SillyTavern.getContext();
        if (chatIdAtStart !== current.getCurrentChatId() || current.chat[messageId] !== message
            || message.mes !== textAtStart || message.swipe_id !== swipeAtStart) {
            toastr.warning('聊天或樓層已變動；圖片已儲存，但未附加到其他樓層。', title);
            return;
        }
        attachImagesToMessage(messageId, saved, {
            title: prompt, negative: payload.negative_prompt ?? payload.negative_text ?? '', seed: result.seed, seeds,
        });
        await current.saveChat();
        toastr.success(`已為第 ${messageId} 樓生成 ${saved.length} 張插圖。`, title, { timeOut: 4000 });
    } catch (error) {
        if (signal.aborted) {
            toastr.info(novel
                ? '已停止等待。NovelAI 仍可能扣點；目前分頁仍會接收結果，關閉或重整會遺失未保存圖片，勿立即重複生成。'
                : '已停止等待。已提交的生圖仍會繼續，可在圖片控制面板歷史紀錄取回。', title);
        } else {
            toastr.error(String(error?.message || error), `${title} 生成失敗`, { timeOut: 10000, escapeHtml: true });
        }
    } finally {
        toast.close();
        activeJobs.delete(buttonEl);
        $button.removeClass(BUSY_CLASS).removeClass('fa-fade');
    }
}

/**
 * Attach saved image URLs to a chat message using the native media gallery.
 * @param {number} messageId
 * @param {string[]} urls
 * @param {{ title: string, negative: string, seed: string | null, seeds?: (string | null)[] }} meta
 */
function attachImagesToMessage(messageId, urls, meta) {
    const context = SillyTavern.getContext();
    const message = context.chat[messageId];
    if (!message) return;

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    if (!Array.isArray(message.extra.media)) {
        message.extra.media = [];
    }
    if (!message.extra.media.length && !message.extra.media_display) {
        message.extra.media_display = MEDIA_DISPLAY.GALLERY;
    }

    const hadMedia = message.extra.media.length > 0;
    for (const [index, url] of urls.entries()) {
        message.extra.media.push({
            url,
            type: MEDIA_TYPE.IMAGE,
            title: meta.title,
            negative: meta.negative,
            source: MEDIA_SOURCE.GENERATED,
            seed: Array.isArray(meta.seeds) ? meta.seeds[index] ?? undefined : meta.seed ?? undefined,
        });
    }
    // Same rule the built-in image extension applies: keep an existing non-inline
    // layout, otherwise show the new image inline.
    message.extra.inline_image = !(hadMedia && !message.extra.inline_image);
    message.extra.media_index = message.extra.media.length - 1;

    const messageElement = $(`#chat .mes[mesid="${messageId}"]`);
    if (messageElement.length) {
        context.appendMediaToMessage(message, messageElement, SCROLL_BEHAVIOR.KEEP);
    }
}

// ---------------------------------------------------------------------------
// Message buttons
// ---------------------------------------------------------------------------

function buttonHtml() {
    return `<div title="生成插圖（Custom Text2Img：ComfyUI / NovelAI）" class="mes_button ${BUTTON_CLASS} fa-solid fa-wand-magic-sparkles"></div>`;
}

function ensureMessageButtons() {
    const settings = getSettings();
    const $template = $('#message_template .extraMesButtons');
    if (settings.enabled) {
        if ($template.length && !$template.find(`.${BUTTON_CLASS}`).length) {
            $template.prepend(buttonHtml());
        }
        $('#chat .mes .extraMesButtons').each(function () {
            if (!$(this).find(`.${BUTTON_CLASS}`).length) {
                $(this).prepend(buttonHtml());
            }
        });
    } else {
        $(`.${BUTTON_CLASS}`).remove();
    }
}

// ---------------------------------------------------------------------------
// Settings UI
// ---------------------------------------------------------------------------

function setStatus(selector, text, kind = '') {
    $(selector).text(text).removeClass('ok error').addClass(kind);
}

function refreshProfileOptions() {
    const settings = getSettings();
    const $select = $('#cmi_profile');
    const profiles = listProfiles();
    $select.empty().append('<option value="">（請選擇）</option>');
    for (const profile of profiles) {
        const label = `${profile.name || profile.id}${profile.model ? ` — ${profile.model}` : ''}${profile.preset ? ` [${profile.preset}]` : ''}`;
        $('<option>').val(profile.id).text(label).appendTo($select);
    }
    if (settings.profileId && !profiles.some((p) => p.id === settings.profileId)) {
        $('<option>').val(settings.profileId).text(`（已遺失的設定檔 ${settings.profileId}）`).appendTo($select);
    }
    $select.val(settings.profileId || '');
}

async function refreshPanelPresets({ silent = false } = {}) {
    const settings = getSettings();
    const $select = $('#cmi_panel_preset');
    const current = settings.panelPreset || '';
    try {
        const data = await getPanelClient().presets();
        const presets = Array.isArray(data?.presets) ? data.presets : [];
        $select.empty().append('<option value="">（不使用，採 workflow 預設值）</option>');
        for (const preset of presets) {
            $('<option>').val(preset.name).text(preset.name).attr('title', preset.created_at || '').appendTo($select);
        }
        if (current && !presets.some((p) => p.name === current)) {
            $('<option>').val(current).text(`${current}（伺服器上不存在）`).appendTo($select);
        }
        $select.val(current);
        if (!silent) toastr.success(`讀取到 ${presets.length} 個預設組合。`, 'Custom Text2Img');
    } catch (error) {
        if (!silent) toastr.error(String(error?.message || error), '讀取預設組合失敗');
        if (current && !$select.find(`option[value="${CSS.escape(current)}"]`).length) {
            $('<option>').val(current).text(current).appendTo($select);
            $select.val(current);
        }
    }
}

async function onTestConnection() {
    setStatus('#cmi_connection_status', '測試中…');
    try {
        const data = await getPanelClient().test();
        setStatus('#cmi_connection_status', `瀏覽器直連成功（${data.baseUrl}，HTTP 輪詢／Quick Tunnel 可用，佇列等待 ${data.waiting}）`, 'ok');
        await refreshPanelPresets({ silent: true });
    } catch (error) {
        setStatus('#cmi_connection_status', String(error?.message || error), 'error');
    }
}

const NOVEL_UI_FIELDS = [
    ['#cmi_novel_model', 'novelModel'], ['#cmi_novel_sampler', 'novelSampler'],
    ['#cmi_novel_schedule', 'novelSchedule'], ['#cmi_novel_steps', 'novelSteps'],
    ['#cmi_novel_scale', 'novelScale'], ['#cmi_novel_cfg_rescale', 'novelCfgRescale'],
    ['#cmi_novel_width', 'novelWidth'], ['#cmi_novel_height', 'novelHeight'],
    ['#cmi_novel_batch_size', 'novelBatchSize'], ['#cmi_novel_seed', 'novelSeed'],
    ['#cmi_novel_negative', 'novelNegativePrompt'],
];

function showProviderSettings() {
    const provider = getSettings().provider;
    $('#cmi_settings [data-cmi-provider]').each(function () {
        $(this).toggle($(this).attr('data-cmi-provider') === provider);
    });
}

function refreshNovelStatus() {
    const configured = Boolean(getSettings().novelVault);
    let unlocked = false;
    try { unlocked = Boolean(unlockedToken()); } catch { /* locked by default */ }
    $('#cmi_novel_token').attr('placeholder', configured ? '已加密儲存；更換時貼上新 Token' : '貼上 Token，再選擇保存方式');
    const text = unlocked
        ? novelSessionMode === 'memory' ? 'Token 僅在目前分頁記憶體中；關閉／重整後需重新輸入。'
            : 'Token 已解鎖；只有加密資料隨 ST 使用者設定保存，密語不保存。'
        : configured ? 'Token 已加密儲存且鎖定，請輸入密語後按「解鎖」。'
            : '尚未儲存 Token。舊版 ST 後端 Token 不會被自動讀取，請重新貼上一次。';
    setStatus('#cmi_novel_status', text, unlocked ? 'ok' : '');
}

function rememberUnlockedToken(token, mode) {
    novelSessionToken = normalizeToken(token);
    unlockedVaultFingerprint = JSON.stringify(getSettings().novelVault);
    novelSessionMode = mode;
    $('#cmi_novel_token, #cmi_novel_passphrase').val('');
    refreshNovelStatus();
}

async function saveNovelToken(clear = false) {
    const settings = getSettings();
    const token = String($('#cmi_novel_token').val() || '').trim();
    if (!clear && !token) {
        setStatus('#cmi_novel_status', '請先貼上 Persistent API Token。', 'error');
        return;
    }
    if (clear) {
        const { callGenericPopup, POPUP_TYPE } = SillyTavern.getContext();
        if (!(await callGenericPopup('刪除此插件的加密 NovelAI Token？不影響 ST 主連線、舊版 secrets 或已提交的任務。', POPUP_TYPE.CONFIRM))) return;
    }
    const buttons = $('#cmi_settings .cmi-token-actions button');
    buttons.prop('disabled', true);
    try {
        const record = clear ? null : await encryptToken(token, String($('#cmi_novel_passphrase').val() || ''));
        if (getSettings() !== settings) throw new Error('使用者設定已變更，請重新操作。');
        settings.novelVault = record;
        saveSettings();
        if (clear) {
            clearUnlockedToken();
            $('#cmi_novel_token, #cmi_novel_passphrase').val('');
            refreshNovelStatus();
        } else rememberUnlockedToken(token, 'vault');
    } catch (error) {
        setStatus('#cmi_novel_status', String(error?.message || error), 'error');
    } finally {
        buttons.prop('disabled', false);
    }
}

async function unlockNovelToken() {
    const settings = getSettings(), record = settings.novelVault;
    if (!record) {
        setStatus('#cmi_novel_status', '尚未加密儲存 Token。', 'error');
        return;
    }
    const buttons = $('#cmi_settings .cmi-token-actions button');
    buttons.prop('disabled', true);
    try {
        const token = await decryptToken(record, String($('#cmi_novel_passphrase').val() || ''));
        if (getSettings() !== settings || settings.novelVault !== record) throw new Error('Token 設定已變更，請重新解鎖。');
        rememberUnlockedToken(token, 'vault');
    } catch (error) {
        setStatus('#cmi_novel_status', String(error?.message || error), 'error');
    } finally {
        buttons.prop('disabled', false);
    }
}

function useNovelTokenForSession() {
    try { rememberUnlockedToken(String($('#cmi_novel_token').val() || ''), 'memory'); }
    catch (error) { setStatus('#cmi_novel_status', String(error?.message || error), 'error'); }
}

async function testNovelConnection() {
    if (String($('#cmi_novel_token').val() || '').trim()) {
        setStatus('#cmi_novel_status', '輸入框有尚未套用的 Token，請先選擇「加密儲存」或「僅本次使用」。', 'error');
        return;
    }
    setStatus('#cmi_novel_status', '驗證 NovelAI Token 與瀏覽器直連（唯讀帳戶 API，不生圖）…');
    $('#cmi_novel_test').prop('disabled', true);
    try {
        const result = await novelai.client(unlockedToken()).test();
        setStatus('#cmi_novel_status', result.message, 'ok');
    } catch (error) {
        setStatus('#cmi_novel_status', String(error?.message || error), 'error');
    } finally {
        $('#cmi_novel_test').prop('disabled', false);
    }
}

function validateAdvanced() {
    const settings = getSettings();
    try {
        parseAdvancedOverrides(settings.advancedOverrides);
        setStatus('#cmi_advanced_status', settings.advancedOverrides.trim() ? 'JSON 有效' : '', 'ok');
    } catch (error) {
        setStatus('#cmi_advanced_status', `JSON 無效：${error.message}`, 'error');
    }
}

function loadSettingsIntoUi() {
    const settings = getSettings();
    $('#cmi_enabled').prop('checked', !!settings.enabled);
    $('#cmi_provider').val(settings.provider);
    for (const [selector, key] of NOVEL_UI_FIELDS) $(selector).val(settings[key]);
    showProviderSettings();
    $('#cmi_base_url').val(settings.baseUrl);
    $('#cmi_password').val(settings.password);
    $('#cmi_use_preset_positive').prop('checked', !!settings.usePresetPositive);
    $('#cmi_use_preset_negative').prop('checked', !!settings.usePresetNegative);
    $('#cmi_max_tokens').val(settings.maxTokens);
    $('#cmi_history_depth').val(settings.historyDepth);
    $('#cmi_system_prompt').val(settings.systemPrompt);
    $('#cmi_user_template').val(settings.userTemplate);
    $('#cmi_review_prompt').prop('checked', !!settings.reviewPrompt);
    $('#cmi_negative').val(settings.negativePrompt);
    $('#cmi_width').val(settings.width);
    $('#cmi_height').val(settings.height);
    $('#cmi_batch_size').val(settings.batchSize);
    $('#cmi_seed').val(settings.seed);
    $('#cmi_advanced').val(settings.advancedOverrides);
    refreshProfileOptions();
    if (!$('#cmi_panel_preset option').filter(function () { return this.value === settings.panelPreset; }).length && settings.panelPreset) {
        $('<option>').val(settings.panelPreset).text(settings.panelPreset).appendTo('#cmi_panel_preset');
    }
    $('#cmi_panel_preset').val(settings.panelPreset || '');
    validateAdvanced();
}

function bindSettingsUi() {
    const settings = getSettings();

    const bindText = (selector, key, transform = (v) => v) => {
        $(selector).on('input change', function () {
            settings[key] = transform($(this).val());
            saveSettings();
        });
    };
    const bindCheckbox = (selector, key) => {
        $(selector).on('change', function () {
            settings[key] = $(this).prop('checked');
            saveSettings();
        });
    };

    for (const [selector, key] of NOVEL_UI_FIELDS) bindText(selector, key, v => String(v));
    bindText('#cmi_provider', 'provider', v => String(v));
    $('#cmi_provider').on('change', () => {
        showProviderSettings();
        if (getSettings().provider === 'novelai') void refreshNovelStatus();
    });
    $('#cmi_novel_save_token').on('click', () => saveNovelToken());
    $('#cmi_novel_clear_token').on('click', () => saveNovelToken(true));
    $('#cmi_novel_unlock').on('click', unlockNovelToken);
    $('#cmi_novel_session').on('click', useNovelTokenForSession);
    $('#cmi_novel_lock').on('click', () => {
        clearUnlockedToken();
        $('#cmi_novel_token, #cmi_novel_passphrase').val('');
        refreshNovelStatus();
    });
    $('#cmi_novel_test').on('click', testNovelConnection);
    bindCheckbox('#cmi_enabled', 'enabled');
    $('#cmi_enabled').on('change', ensureMessageButtons);
    bindText('#cmi_base_url', 'baseUrl', (v) => String(v).trim());
    bindText('#cmi_password', 'password', (v) => String(v));
    bindCheckbox('#cmi_use_preset_positive', 'usePresetPositive');
    bindCheckbox('#cmi_use_preset_negative', 'usePresetNegative');
    bindText('#cmi_max_tokens', 'maxTokens', (v) => Math.max(16, Number(v) || defaultSettings.maxTokens));
    bindText('#cmi_history_depth', 'historyDepth', (v) => Math.max(0, Number(v) || 0));
    bindText('#cmi_system_prompt', 'systemPrompt', (v) => String(v));
    bindText('#cmi_user_template', 'userTemplate', (v) => String(v));
    bindCheckbox('#cmi_review_prompt', 'reviewPrompt');
    bindText('#cmi_negative', 'negativePrompt', (v) => String(v));
    bindText('#cmi_width', 'width', (v) => String(v).trim());
    bindText('#cmi_height', 'height', (v) => String(v).trim());
    bindText('#cmi_batch_size', 'batchSize', (v) => Math.max(1, Number(v) || 1));
    bindText('#cmi_seed', 'seed', (v) => String(v).trim());
    bindText('#cmi_advanced', 'advancedOverrides', (v) => String(v));
    $('#cmi_advanced').on('input change', validateAdvanced);

    $('#cmi_profile').on('change', function () {
        settings.profileId = String($(this).val() || '');
        saveSettings();
    });
    $('#cmi_panel_preset').on('change', function () {
        settings.panelPreset = String($(this).val() || '');
        saveSettings();
    });

    $('#cmi_password_toggle').on('click', function () {
        const $input = $('#cmi_password');
        const reveal = $input.attr('type') === 'password';
        $input.attr('type', reveal ? 'text' : 'password');
        $(this).toggleClass('fa-eye', !reveal).toggleClass('fa-eye-slash', reveal);
    });
    $('#cmi_test_connection').on('click', onTestConnection);
    $('#cmi_refresh_presets').on('click', () => refreshPanelPresets());
    $('#cmi_refresh_profiles').on('click', refreshProfileOptions);
    $('#cmi_restore_prompts').on('click', () => {
        settings.systemPrompt = DEFAULT_SYSTEM_PROMPT;
        settings.userTemplate = DEFAULT_USER_TEMPLATE;
        $('#cmi_system_prompt').val(settings.systemPrompt);
        $('#cmi_user_template').val(settings.userTemplate);
        saveSettings();
        toastr.info('已還原預設模板。', 'Custom Text2Img');
    });
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

async function init() {
    const context = SillyTavern.getContext();
    getSettings();

    const html = await context.renderExtensionTemplateAsync(EXTENSION_FOLDER, 'settings');
    $('#extensions_settings').append(html);
    loadSettingsIntoUi();
    bindSettingsUi();

    $(document).on('click', `.${BUTTON_CLASS}`, function (event) {
        event.preventDefault();
        onMessageButtonClick($(this));
    });

    ensureMessageButtons();
    const { eventSource, event_types } = context;
    eventSource.on(event_types.APP_READY, () => {
        ensureMessageButtons();
        const settings = getSettings();
        if (settings.provider === 'comfy-modal' && settings.baseUrl && settings.password) {
            refreshPanelPresets({ silent: true });
        }
        if (settings.provider === 'novelai') void refreshNovelStatus();
    });
    eventSource.on(event_types.CHAT_CHANGED, ensureMessageButtons);
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, ensureMessageButtons);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, ensureMessageButtons);
    eventSource.on(event_types.MESSAGE_SWIPED, ensureMessageButtons);
    eventSource.on(event_types.CONNECTION_PROFILE_LOADED, refreshProfileOptions);
    eventSource.on(event_types.SETTINGS_UPDATED, () => {
        refreshProfileOptions();
        if (getSettings().provider === 'novelai') refreshNovelStatus();
    });
    window.addEventListener('beforeunload', (event) => {
        if (!novelai.busy) return;
        event.preventDefault();
        event.returnValue = '';
    });

    console.log(LOG_PREFIX, 'initialized (browser-only providers)');
}

init().catch((error) => console.error(LOG_PREFIX, 'initialization failed', error));
