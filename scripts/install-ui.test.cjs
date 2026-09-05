const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installUi, parseArgs, ID, LEGACY_ID, RUNTIME_FILES } = require('./install-ui.cjs');
const source = path.resolve(__dirname, '../extension');

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'custom-text2img-install-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'sillytavern' }));
    const user = path.join(root, 'data/default-user');
    fs.mkdirSync(path.join(user, 'extensions'), { recursive: true });
    return { root, user, target: path.join(user, 'extensions', ID), legacy: path.join(user, 'extensions', LEGACY_ID) };
}

test('installs only runtime files, uses one source of truth and is idempotent', (t) => {
    const { root, target } = fixture(t);
    assert.equal(installUi({ root, check: true }).changed, true);
    assert.equal(fs.existsSync(target), false);
    assert.equal(installUi({ root }).changed, true);
    assert.deepEqual(fs.readdirSync(target).sort(), [...RUNTIME_FILES].sort());
    for (const name of RUNTIME_FILES) assert.deepEqual(fs.readFileSync(path.join(source, name)), fs.readFileSync(path.join(target, name)));
    assert.equal(installUi({ root }).changed, false);
    assert.equal(installUi({ root, check: true }).changed, false);
    assert.equal(fs.existsSync(path.join(root, 'config.yaml')), false);
    assert.equal(fs.existsSync(path.join(root, 'plugins')), false, 'UI installation must not require or install a server plugin');
    for (const file of RUNTIME_FILES.filter(name => name.endsWith('.js'))) {
        const text = fs.readFileSync(path.join(target, file), 'utf8');
        for (const match of text.matchAll(/^import .* from ['"]\.\/([^'"]+)['"];$/gm)) {
            assert.ok(RUNTIME_FILES.includes(match[1]), `Missing runtime import ${match[1]}`);
        }
    }
});

test('migration backs up both previous deployment and legacy UI; user data is untouched', (t) => {
    const { root, user, target, legacy } = fixture(t);
    installUi({ root });
    fs.writeFileSync(path.join(target, 'index.js'), '// customized previous UI');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'index.js'), '// legacy UI');
    fs.writeFileSync(path.join(user, 'settings.json'), '{"fixture":"do not change"}');
    assert.throws(() => installUi({ root }), /--migrate/);
    assert.equal(installUi({ root, migrate: true, check: true }).changed, true);
    assert.ok(fs.existsSync(legacy));
    const result = installUi({ root, migrate: true });
    assert.equal(result.backups.length, 2);
    assert.equal(fs.readFileSync(path.join(result.backups[0], 'index.js'), 'utf8'), '// customized previous UI');
    assert.equal(fs.readFileSync(path.join(result.backups[1], 'index.js'), 'utf8'), '// legacy UI');
    assert.equal(fs.existsSync(legacy), false);
    assert.equal(fs.readFileSync(path.join(user, 'settings.json'), 'utf8'), '{"fixture":"do not change"}');
    assert.equal(installUi({ root, check: true }).changed, false);
});

test('rejects path traversal, absent users, symlink targets and double global installations', (t) => {
    const { root, target } = fixture(t);
    assert.throws(() => installUi({ root, user: '../another-user' }), /user/);
    assert.throws(() => installUi({ root, user: 'missing-user' }), /使用者不存在/);
    fs.symlinkSync(source, target, 'dir');
    assert.throws(() => installUi({ root }), /符號連結/);
    fs.unlinkSync(target);
    fs.mkdirSync(path.join(root, 'public/scripts/extensions/third-party', LEGACY_ID), { recursive: true });
    assert.throws(() => installUi({ root, migrate: true }), /全域擴展/);
    assert.equal(fs.existsSync(target), false);
});

test('preflight catches missing source files without changing the existing deployment', (t) => {
    const { root, target } = fixture(t);
    installUi({ root });
    const incomplete = path.join(root, 'incomplete');
    fs.mkdirSync(incomplete);
    fs.copyFileSync(path.join(source, 'manifest.json'), path.join(incomplete, 'manifest.json'));
    const before = fs.readFileSync(path.join(target, 'index.js'));
    assert.throws(() => installUi({ root, source: incomplete }), /ENOENT/);
    assert.deepEqual(fs.readFileSync(path.join(target, 'index.js')), before);
});

test('failed final rename restores both old directories', (t) => {
    const { root, target, legacy } = fixture(t);
    installUi({ root });
    fs.writeFileSync(path.join(target, 'index.js'), '// old deployment');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'index.js'), '// old legacy');
    const rename = fs.renameSync;
    t.mock.method(fs, 'renameSync', (from, to) => {
        if (path.basename(from).startsWith('.custom-text2img-') && to === target) throw new Error('simulated rename failure');
        return rename(from, to);
    });
    assert.throws(() => installUi({ root, migrate: true }), /simulated/);
    assert.equal(fs.readFileSync(path.join(target, 'index.js'), 'utf8'), '// old deployment');
    assert.equal(fs.readFileSync(path.join(legacy, 'index.js'), 'utf8'), '// old legacy');
});

test('custom data root works and CLI only accepts known options', (t) => {
    const { root } = fixture(t);
    const dataRoot = path.join(root, 'custom-data');
    fs.mkdirSync(path.join(dataRoot, 'test-user'), { recursive: true });
    const result = installUi({ root, dataRoot, user: 'test-user' });
    assert.ok(result.destination.startsWith(dataRoot));
    assert.deepEqual(parseArgs(['--user', 'test-user', '--migrate', '--check']), { user: 'test-user', migrate: true, check: true });
    assert.throws(() => parseArgs(['--user']), /缺少/);
    assert.throws(() => parseArgs(['--unknown']), /不認識/);
});
