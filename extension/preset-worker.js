import { cleanScene } from './scene-text.js';
import { createPresetState, preparePresetRequest, acceptPresetResponse } from './preset-runtime.js';

self.onmessage = ({ data }) => {
    try {
        let result;
        switch (data.type) {
            case 'clean': result = cleanScene(data.payload.snapshot, data.payload.bodyCleanupRules); break;
            case 'create': result = createPresetState(data.payload); break;
            case 'prepare': result = preparePresetRequest(data.payload.state, data.payload.userText ?? null); break;
            case 'accept': result = acceptPresetResponse(data.payload.state, data.payload.content); break;
            default: throw new Error('未知的獨立預設操作。');
        }
        self.postMessage({ ok: true, result });
    } catch (error) {
        self.postMessage({ ok: false, error: {
            name: error?.name || 'Error', message: String(error?.message || error), stack: error?.stack,
        } });
    }
};
