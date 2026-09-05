'use strict';

const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { HttpError } = require('./http.js');

// Independent of SillyTavern's main NovelAI connection. Never stored in extensionSettings.
const SECRET_KEY = 'api_key_sillytavern_custom_text2img_novelai';
let api;

function userRoot(req) {
    const root = req.user?.directories?.root;
    if (typeof root !== 'string' || !root) throw new HttpError(401, '需要 SillyTavern 使用者登入。');
    return root;
}

async function managerFor(req) {
    userRoot(req);
    // This repository is installed under <SillyTavern>/plugins/<plugin-id>.
    api ??= import(pathToFileURL(path.resolve(__dirname, '../../../src/endpoints/secrets.js')).href);
    const { SecretManager } = await api;
    return new SecretManager(req.user.directories);
}

function tokenIds(manager) {
    // getSecretState() only enumerates ST's built-in SECRET_KEYS, so it hides
    // custom plugin keys. Use the server-only store API and retain ONLY our IDs.
    // Never return or log the raw store (which also contains other user secrets).
    return (manager.getAllSecrets()[SECRET_KEY] ?? []).map(entry => entry.id);
}

function createSecretsStore(createManager = managerFor) {
    return {
        async read(req) {
            return (await createManager(req)).readSecret(SECRET_KEY);
        },
        async write(req, value) {
            const manager = await createManager(req);
            // Write first so a failed write cannot erase a working key. Do not keep old tokens.
            const id = manager.writeSecret(SECRET_KEY, value, 'Custom Text2Img — NovelAI');
            for (const previousId of tokenIds(manager)) {
                if (previousId !== id) manager.deleteSecret(SECRET_KEY, previousId);
            }
        },
        async clear(req) {
            const manager = await createManager(req);
            for (const id of tokenIds(manager)) manager.deleteSecret(SECRET_KEY, id);
        },
    };
}

const secrets = createSecretsStore();
module.exports = { secrets, userRoot, SECRET_KEY, createSecretsStore };
