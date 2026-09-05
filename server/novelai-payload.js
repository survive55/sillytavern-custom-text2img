'use strict';

const { randomInt } = require('node:crypto');
const { HttpError } = require('./http.js');

const MODELS = Object.freeze([
    'nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated',
    'nai-diffusion-4-full', 'nai-diffusion-4-curated-preview',
    'nai-diffusion-3', 'nai-diffusion-furry-3',
]);
const SAMPLERS = Object.freeze(['k_euler_ancestral', 'k_euler', 'k_dpmpp_2m', 'k_dpmpp_sde', 'k_dpmpp_2s_ancestral']);
const SCHEDULES = Object.freeze(['native', 'karras', 'exponential', 'polyexponential']);

function numeric(value, fallback, name, min, max, integer = false) {
    const n = value === undefined || value === '' ? fallback : value;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
        throw new HttpError(400, `${name} 必須是 ${min}–${max} 的${integer ? '整數' : '數字'}。`);
    }
    return n;
}

function choice(value, fallback, choices, name) {
    const result = value ?? fallback;
    if (!choices.includes(result)) throw new HttpError(400, `不支援的 NovelAI ${name}。`);
    return result;
}

/** Deliberately a text-to-image allowlist, not a generic NovelAI request proxy. */
function buildNovelAIRequest(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new HttpError(400, '需要 NovelAI payload。');
    const allowed = new Set(['prompt', 'negative_prompt', 'model', 'width', 'height', 'steps', 'scale', 'cfg_rescale', 'seed', 'sampler', 'noise_schedule', 'n_samples']);
    if (Object.keys(payload).some(key => !allowed.has(key))) throw new HttpError(400, 'NovelAI payload 含有不支援的欄位；不能傳入 URL、Token 或其他生成模式。');
    if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || payload.prompt.length > 30000) {
        throw new HttpError(400, 'NovelAI prompt 必須是非空文字（最多 30000 字元）。');
    }
    const negative = payload.negative_prompt ?? '';
    if (typeof negative !== 'string' || negative.length > 30000) throw new HttpError(400, '負向提示詞格式不正確。');
    const model = choice(payload.model, MODELS[0], MODELS, '模型');
    const width = numeric(payload.width, 1024, 'width', 64, 2048, true);
    const height = numeric(payload.height, 1024, 'height', 64, 2048, true);
    const samples = numeric(payload.n_samples, 1, 'n_samples', 1, 4, true);
    if (width % 64 || height % 64) throw new HttpError(400, 'NovelAI 寬高必須是 64 的倍數。');
    // Local safety limits, not a claim about subscription entitlements or free generations.
    if (width * height > 3145728 || width * height * samples > 4194304) {
        throw new HttpError(400, '超過插件限制：每張最多 3145728 像素，每次總計最多 4194304 像素。');
    }
    let seed = payload.seed;
    if (seed === undefined || seed === '' || seed === -1 || seed === '-1') seed = randomInt(0, 0x100000000);
    else if (typeof seed === 'string' && /^\d{1,10}$/.test(seed)) seed = Number(seed);
    seed = numeric(seed, 0, 'seed', 0, 0xffffffff, true);
    const parameters = {
        params_version: 3,
        width, height, n_samples: samples, seed,
        steps: numeric(payload.steps, 28, 'steps', 1, 50, true),
        scale: numeric(payload.scale, 5, 'scale', 0, 10),
        cfg_rescale: numeric(payload.cfg_rescale, 0, 'cfg_rescale', 0, 1),
        sampler: choice(payload.sampler, 'k_euler_ancestral', SAMPLERS, '取樣器'),
        noise_schedule: choice(payload.noise_schedule, 'native', SCHEDULES, '噪聲排程'),
        negative_prompt: negative,
        image_format: 'png',
        qualityToggle: false,
        ucPreset: 0,
        prefer_brownian: true,
        deliberate_euler_ancestral_bug: false,
        dynamic_thresholding: false,
        legacy: false,
        legacy_v3_extend: false,
        sm: false,
        sm_dyn: false,
        add_original_image: false,
    };
    if (model.startsWith('nai-diffusion-4')) {
        parameters.v4_prompt = {
            caption: { base_caption: payload.prompt, char_captions: [] },
            use_coords: false, use_order: true,
        };
        parameters.v4_negative_prompt = {
            caption: { base_caption: negative, char_captions: [] },
        };
    }
    return { action: 'generate', input: payload.prompt, model, parameters };
}

module.exports = { buildNovelAIRequest, MODELS, SAMPLERS, SCHEDULES };
