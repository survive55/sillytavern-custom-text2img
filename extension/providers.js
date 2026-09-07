/** Pure provider/settings helpers. No tokens or side effects belong in this module. */
export const SETTINGS_KEY = 'sillytavern_custom_text2img';
export const LEGACY_SETTINGS_KEY = 'comfy_modal_illustrator';
export const PROVIDER_DEFAULTS = Object.freeze({
    provider: 'comfy-modal',
    novelModel: 'nai-diffusion-4-5-full',
    novelSampler: 'k_euler_ancestral',
    novelSchedule: 'native',
    novelSteps: 28,
    novelScale: 5,
    novelCfgRescale: 0,
    novelWidth: 1024,
    novelHeight: 1024,
    novelBatchSize: 1,
    novelSeed: '',
    novelNegativePrompt: '',
    // Authenticated ciphertext only; plaintext tokens and unlock phrases never belong here.
    novelVault: null,
});

export function migrateSettings(container, defaults) {
    let changed = false;
    if (!container[SETTINGS_KEY] || typeof container[SETTINGS_KEY] !== 'object' || Array.isArray(container[SETTINGS_KEY])) {
        const legacy = container[LEGACY_SETTINGS_KEY];
        const settings = structuredClone(defaults);
        if (legacy && typeof legacy === 'object' && !Array.isArray(legacy)) {
            for (const key of Object.keys(defaults)) {
                if (Object.hasOwn(legacy, key)) settings[key] = structuredClone(legacy[key]);
            }
        }
        container[SETTINGS_KEY] = settings;
        changed = true;
    }
    const settings = container[SETTINGS_KEY];
    for (const [key, value] of Object.entries(defaults)) {
        if (!Object.hasOwn(settings, key)) {
            settings[key] = structuredClone(value);
            changed = true;
        }
    }
    if (!['comfy-modal', 'novelai', 'anima-mcp'].includes(settings.provider)) {
        settings.provider = 'comfy-modal';
        changed = true;
    }
    return { settings, changed };
}

export function providerConnection(settings) {
    if (settings.provider === 'anima-mcp') return { provider: 'anima-mcp' };
    if (settings.provider === 'novelai') return { provider: 'novelai' };
    if (settings.provider !== 'comfy-modal') throw new Error('不支援的生圖來源');
    return { provider: 'comfy-modal', connection: { baseUrl: String(settings.baseUrl ?? '').trim(), password: settings.password } };
}

export function buildNovelPayload(prompt, settings) {
    return {
        prompt,
        negative_prompt: String(settings.novelNegativePrompt ?? ''),
        model: settings.novelModel,
        sampler: settings.novelSampler,
        noise_schedule: settings.novelSchedule,
        steps: Number(settings.novelSteps),
        scale: Number(settings.novelScale),
        cfg_rescale: Number(settings.novelCfgRescale),
        width: Number(settings.novelWidth),
        height: Number(settings.novelHeight),
        n_samples: Number(settings.novelBatchSize),
        seed: String(settings.novelSeed ?? '').trim(),
    };
}
