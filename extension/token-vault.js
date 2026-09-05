import { base64ToBytes, bytesToBase64, HttpError, normalizeToken } from './http.js';

export const VAULT_ITERATIONS = 600000;
const AAD = new TextEncoder().encode('sillytavern-custom-text2img/novelai-token/v1');

function webCrypto() {
    if (!globalThis.crypto?.subtle) {
        throw new HttpError(400, 'Token 加密需要 HTTPS 或 localhost 的安全環境；不會退回明文保存。');
    }
    return globalThis.crypto;
}

function passphraseBytes(passphrase) {
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) {
        throw new HttpError(400, '請使用 12–1024 字元的獨立解鎖密語（不要填 NovelAI 帳號密碼）。');
    }
    return new TextEncoder().encode(passphrase);
}

async function derive(passphrase, salt, usages) {
    const api = webCrypto();
    const bytes = passphraseBytes(passphrase);
    try {
        const material = await api.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
        return await api.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: VAULT_ITERATIONS },
            material, { name: 'AES-GCM', length: 256 }, false, usages);
    } finally { bytes.fill(0); }
}

/** Only this authenticated ciphertext is persisted in the current ST user's settings. */
export async function encryptToken(value, passphrase) {
    const token = normalizeToken(value);
    const api = webCrypto();
    const salt = api.getRandomValues(new Uint8Array(16));
    const iv = api.getRandomValues(new Uint8Array(12));
    const key = await derive(passphrase, salt, ['encrypt']);
    const bytes = new TextEncoder().encode(token);
    try {
        const encrypted = await api.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 }, key, bytes);
        return { version: 1, kdf: 'PBKDF2-SHA-256', iterations: VAULT_ITERATIONS,
            salt: bytesToBase64(salt), iv: bytesToBase64(iv), ciphertext: bytesToBase64(new Uint8Array(encrypted)) };
    } finally { bytes.fill(0); }
}

function decodeField(text, min, max) {
    if (typeof text !== 'string' || text.length > Math.ceil(max / 3) * 4 || text.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) {
        throw new Error('Invalid vault encoding');
    }
    const bytes = base64ToBytes(text);
    if (bytes.length < min || bytes.length > max) throw new Error('Invalid vault size');
    return bytes;
}

export async function decryptToken(record, passphrase) {
    webCrypto();
    passphraseBytes(passphrase).fill(0);
    try {
        if (!record || record.version !== 1 || record.kdf !== 'PBKDF2-SHA-256' || record.iterations !== VAULT_ITERATIONS) {
            throw new Error('Unsupported vault');
        }
        const salt = decodeField(record.salt, 16, 16), iv = decodeField(record.iv, 12, 12);
        const ciphertext = decodeField(record.ciphertext, 17, 4112);
        const key = await derive(passphrase, salt, ['decrypt']);
        const decrypted = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 }, key, ciphertext));
        try { return normalizeToken(new TextDecoder('utf-8', { fatal: true }).decode(decrypted)); }
        finally { decrypted.fill(0); }
    } catch {
        throw new HttpError(400, '無法解鎖 Token：密語不正確，或加密資料已損毀／版本不支援。');
    }
}
