import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import { SETTINGS_KEY, LEGACY_SETTINGS_KEY, PROVIDER_DEFAULTS, migrateSettings, providerConnection, buildNovelPayload } from '../providers.js';

const defaults = { enabled: true, baseUrl: 'http://127.0.0.1:8800', password: '', profileId: '', seed: '', panelPreset: '', ...PROVIDER_DEFAULTS };

test('legacy settings migrate once, preserve connection/profile/preset/64-bit seed, and remain available for rollback', () => {
    const legacy = { password: 'fake-panel-password', baseUrl: 'https://example.trycloudflare.com', profileId: 'independent-profile', panelPreset: 'illustration', seed: '18446744073709551613', unknownToken: 'must-not-copy' };
    const state = { [LEGACY_SETTINGS_KEY]: structuredClone(legacy) };
    const { settings, changed } = migrateSettings(state, defaults);
    assert.equal(changed, true);
    assert.equal(settings.provider, 'comfy-modal');
    assert.equal(settings.profileId, legacy.profileId);
    assert.equal(settings.password, legacy.password);
    assert.equal(settings.seed, legacy.seed);
    assert.equal(settings.panelPreset, legacy.panelPreset);
    assert.equal(settings.novelSeed, '');
    assert.equal(settings.unknownToken, undefined);
    assert.deepEqual(state[LEGACY_SETTINGS_KEY], legacy);
    settings.provider = 'novelai';
    settings.novelSteps = 20;
    assert.equal(migrateSettings(state, defaults).changed, false);
    assert.equal(state[SETTINGS_KEY].provider, 'novelai');
    assert.equal(state[SETTINGS_KEY].novelSteps, 20);
});

test('fresh settings and malformed old settings receive independent defaults', () => {
    for (const legacy of [null, [], 'invalid', undefined]) {
        const { settings } = migrateSettings({ [LEGACY_SETTINGS_KEY]: legacy }, defaults);
        assert.deepEqual(settings, defaults);
        assert.notEqual(settings, defaults);
    }
    const state = { [SETTINGS_KEY]: { provider: 'unknown', novelSteps: 21 } };
    assert.equal(migrateSettings(state, defaults).settings.provider, 'comfy-modal');
    assert.equal(state[SETTINGS_KEY].novelSteps, 21);
});

test('NovelAI never receives a panel URL, password, workflow overrides or ComfyUI seed', () => {
    const settings = { ...defaults, provider: 'novelai', baseUrl: 'https://private.invalid', password: 'private-password', seed: '18446744073709551613', advancedOverrides: '{"loras":["private"]}', novelSeed: '0' };
    const connection = providerConnection(settings);
    assert.deepEqual(connection, { provider: 'novelai' });
    const request = buildNovelPayload('landscape', settings);
    assert.equal(request.seed, '0');
    assert.equal(request.width, 1024);
    assert.equal(request.steps, 28);
    assert.equal(request.model, 'nai-diffusion-4-5-full');
    assert.ok(!JSON.stringify({ connection, request }).includes('private'));
    assert.ok(!JSON.stringify(request).includes(settings.seed));
});

test('a chosen connection is frozen independently of later source changes, numeric UI inputs work', () => {
    const settings = { ...defaults, baseUrl: ' https://panel.trycloudflare.com/ ', password: 'fake-password', novelSteps: '24', novelScale: '0' };
    const plan = providerConnection(settings);
    settings.provider = 'novelai';
    settings.baseUrl = 'https://another.invalid';
    settings.password = 'changed';
    assert.deepEqual(plan, { provider: 'comfy-modal', connection: { baseUrl: 'https://panel.trycloudflare.com/', password: 'fake-password' } });
    assert.equal(buildNovelPayload('landscape', settings).scale, 0);
    assert.equal(buildNovelPayload('landscape', settings).steps, 24);
    assert.throws(() => providerConnection({ provider: 'unknown' }), /不支援/);
});

test('UI NovelAI selectors exist exactly once; token input is not a persistent setting', () => {
    const html = fs.readFileSync(new URL('../settings.html', import.meta.url), 'utf8');
    const js = fs.readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
    assert.equal(ids.length, new Set(ids).size);
    for (const match of js.matchAll(/\['#(cmi_novel_[^']+)', '([^']+)'\]/g)) {
        assert.ok(ids.includes(match[1]), match[1]);
        assert.ok(Object.hasOwn(PROVIDER_DEFAULTS, match[2]), match[2]);
    }
    assert.ok(ids.includes('cmi_provider'));
    assert.ok(ids.includes('cmi_novel_token'));
    assert.ok(!Object.keys(PROVIDER_DEFAULTS).some(key => /token|password/i.test(key)));
    assert.match(js, /client\.output\(path, signal\)/);
    assert.match(js, /current\.chat\[messageId\] !== message/);
    assert.doesNotMatch(js, /api\/plugins|enableServerPlugins|pluginPost|isPluginAvailable/);
    assert.ok(ids.includes('cmi_novel_passphrase'));
    assert.ok(ids.includes('cmi_novel_unlock'));
    assert.ok(ids.includes('cmi_novel_session'));
    assert.ok(!Object.keys(PROVIDER_DEFAULTS).some(key => /passphrase/i.test(key)));
});
