import assert from 'node:assert/strict';
import { test } from 'node:test';
import { encryptToken, decryptToken, VAULT_ITERATIONS } from '../token-vault.js';

const TOKEN = 'fake-persistent-api-token';
const PASSPHRASE = 'a separate unlock phrase for tests';

test('vault persists authenticated ciphertext only and unlocks across reload-equivalent serialization', async () => {
    const record = await encryptToken(TOKEN, PASSPHRASE);
    const persisted = JSON.stringify(record);
    assert.ok(!persisted.includes(TOKEN)); assert.ok(!persisted.includes(PASSPHRASE));
    assert.equal(record.iterations, 600000); assert.equal(VAULT_ITERATIONS, 600000);
    assert.equal(await decryptToken(JSON.parse(persisted), PASSPHRASE), TOKEN);
    const second = await encryptToken(TOKEN, PASSPHRASE);
    assert.notEqual(record.salt, second.salt); assert.notEqual(record.iv, second.iv); assert.notEqual(record.ciphertext, second.ciphertext);
});

test('wrong phrases and modified salt/IV/ciphertext do not reveal token or underlying crypto details', async () => {
    const record = await encryptToken(TOKEN, PASSPHRASE);
    await assert.rejects(decryptToken(record, 'another wrong long phrase'), /無法解鎖/);
    for (const field of ['salt', 'iv', 'ciphertext']) {
        const tampered = { ...record, [field]: (record[field][0] === 'A' ? 'B' : 'A') + record[field].slice(1) };
        await assert.rejects(decryptToken(tampered, PASSPHRASE), error => {
            assert.match(error.message, /無法解鎖/); assert.ok(!error.message.includes(TOKEN)); return true;
        });
    }
});

test('invalid records and untrusted KDF work factors fail before any expensive derivation', async () => {
    for (const record of [null, {}, { version: 2 }, { version: 1, kdf: 'PBKDF2-SHA-256', iterations: 1e12 },
        { version: 1, kdf: 'PBKDF2-SHA-256', iterations: VAULT_ITERATIONS, salt: 'a'.repeat(10000) }]) {
        await assert.rejects(decryptToken(record, PASSPHRASE), /無法解鎖/);
    }
});

test('weak unlock phrases and malformed tokens cannot overwrite a saved vault', async () => {
    for (const phrase of ['', 'short', 'x'.repeat(1025)]) await assert.rejects(encryptToken(TOKEN, phrase), /密語/);
    for (const token of ['', 'Bearer token', 'has space', 'x'.repeat(4097)]) await assert.rejects(encryptToken(token, PASSPHRASE), /Token/);
});

test('an insecure context never falls back to plaintext persistence', async t => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });
    t.after(() => Object.defineProperty(globalThis, 'crypto', descriptor));
    await assert.rejects(encryptToken(TOKEN, PASSPHRASE), /HTTPS.*不會退回明文/);
});
