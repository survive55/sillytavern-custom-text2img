const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createSecretsStore, SECRET_KEY, userRoot } = require('./st-secrets.js');

/** Matches ST 1.18: getSecretState omits custom keys; getAllSecrets includes them. */
function fixture() {
    const data = { api_key_novel: [{ id: 'main', value: 'main-token-not-real', active: true }] };
    let serial = 0;
    const manager = {
        getSecretState: () => ({ api_key_novel: [{ id: 'main', active: true, value: '***' }] }),
        getAllSecrets: () => structuredClone(data),
        readSecret: key => data[key]?.find(entry => entry.active)?.value || '',
        writeSecret(key, value) {
            for (const entry of data[key] ?? []) entry.active = false;
            const id = String(++serial);
            (data[key] ??= []).push({ id, value, active: true });
            return id;
        },
        deleteSecret(key, id) {
            data[key] = data[key].filter(entry => entry.id !== id);
            if (!data[key].length) delete data[key];
            else if (!data[key].some(entry => entry.active)) data[key][0].active = true;
        },
    };
    return { data, manager, store: createSecretsStore(async () => manager) };
}

test('saving a replacement leaves only the new custom token, without touching the main NovelAI token', async () => {
    const { data, manager, store } = fixture();
    await store.write({}, 'first-test-token');
    assert.equal(manager.getSecretState()[SECRET_KEY], undefined);
    await store.write({}, 'second-test-token');
    assert.equal(await store.read({}), 'second-test-token');
    assert.equal(data[SECRET_KEY].length, 1);
    assert.equal(data.api_key_novel[0].value, 'main-token-not-real');
});

test('clear removes active and inactive custom tokens even though masked state omits them', async () => {
    const { data, manager, store } = fixture();
    manager.writeSecret(SECRET_KEY, 'old-test-token');
    manager.writeSecret(SECRET_KEY, 'new-test-token');
    await store.clear({});
    assert.equal(await store.read({}), '');
    assert.equal(Object.hasOwn(data, SECRET_KEY), false);
    assert.equal(data.api_key_novel[0].value, 'main-token-not-real');
    await store.clear({});
});

test('failed new-token writes cannot erase a working token', async () => {
    const { manager, store } = fixture();
    await store.write({}, 'working-test-token');
    manager.writeSecret = () => { throw new Error('disk failure'); };
    await assert.rejects(store.write({}, 'replacement'), /disk failure/);
    assert.equal(await store.read({}), 'working-test-token');
});

test('host bridge requires an authenticated user directory', () => {
    assert.throws(() => userRoot({}), error => error.status === 401);
    assert.throws(() => userRoot({ user: { directories: { root: '' } } }), error => error.status === 401);
    assert.equal(userRoot({ user: { directories: { root: '/fixture/user' } } }), '/fixture/user');
});
