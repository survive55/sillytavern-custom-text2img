'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const source = fs.readFileSync(path.join(root, 'extension/index.js'), 'utf8');
const layouts = [
    { name: 'GitHub repository', directory: root, prefix: 'extension/' },
    { name: 'install-ui deployment', directory: path.join(root, 'extension'), prefix: '' },
];

for (const { name, directory, prefix } of layouts) {
    test(`${name}: manifest selects browser assets, never the server entry`, () => {
        const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
        assert.equal(manifest.display_name, 'SillyTavern Custom Text2Img');
        assert.equal(manifest.version, pkg.version);
        assert.equal(manifest.minimum_client_version, '1.14.0', 'Both layouts must load on the native-media API baseline');
        assert.equal(manifest.js, `${prefix}index.js`);
        assert.equal(manifest.css, `${prefix}style.css`);
        assert.ok(manifest.author);
        assert.ok(manifest.dependencies.includes('connection-manager'));
        for (const file of [manifest.js, manifest.css, `${prefix}settings.html`]) {
            assert.ok(fs.statSync(path.join(directory, file)).isFile(), `Missing browser asset: ${file}`);
        }
        assert.equal(path.resolve(directory, manifest.js), path.join(root, 'extension/index.js'));
        assert.notEqual(path.resolve(directory, manifest.js), path.join(root, pkg.main));
    });

    test(`${name}: browser imports resolve at the correct directory depth`, () => {
        const entry = new URL(`https://st.example/scripts/extensions/third-party/${pkg.name}/${prefix}index.js`);
        const uiDirectory = new URL('.', entry).pathname;
        const hostModules = new Set(['/scripts/utils.js', '/scripts/constants.js']);
        const resolvedImports = [...source.matchAll(/^import .* from ['"]([^'"]+)['"];$/gm)]
            .map(match => new URL(match[1], entry).pathname);
        assert.ok(resolvedImports.length >= 4);
        for (const imported of resolvedImports) {
            if (hostModules.has(imported)) continue;
            assert.ok(imported.startsWith(uiDirectory), `Incorrect browser import: ${imported}`);
            assert.ok(fs.statSync(path.join(root, 'extension', imported.slice(uiDirectory.length))).isFile());
        }
        for (const imported of hostModules) assert.ok(resolvedImports.includes(imported), `Missing ST import: ${imported}`);
    });

    for (const folder of [pkg.name, 'renamed-extension']) {
        test(`${name}: settings template follows the entry URL in ${folder}`, () => {
            const declaration = source.match(/^const EXTENSION_FOLDER = [\s\S]*?;/m)?.[0];
            assert.ok(declaration, 'The frontend must define its template directory');
            const entryUrl = `https://st.example/scripts/extensions/third-party/${folder}/${prefix}index.js?v=test`;
            const extensionFolder = vm.runInNewContext(
                `${declaration.replaceAll('import.meta.url', 'entryUrl')}\nEXTENSION_FOLDER`,
                { URL, entryUrl },
            );
            assert.equal(extensionFolder, `third-party/${folder}/${prefix}`.replace(/\/$/, ''));
            assert.equal(`/scripts/extensions/${extensionFolder}/settings.html`, new URL('settings.html', entryUrl).pathname);
        });
    }
}

test('both manifests share metadata and differ only in relative browser asset paths', () => {
    const repositoryManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
    const deploymentManifest = require('../extension/manifest.json');
    assert.deepEqual(repositoryManifest, {
        ...deploymentManifest,
        js: `extension/${deploymentManifest.js}`,
        css: `extension/${deploymentManifest.css}`,
    });
});

test('the existing CommonJS server plugin remains a separate installable entry', () => {
    const plugin = require('../index.js');
    assert.equal(pkg.type, 'commonjs');
    assert.equal(require('../extension/package.json').type, 'module');
    assert.equal(plugin.info.id, pkg.name);
    assert.equal(typeof plugin.init, 'function');
    assert.equal(typeof plugin.exit, 'function');
});
