'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');

function check(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (['.git', 'node_modules'].includes(entry.name)) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) check(file);
        else if (/\.(?:js|cjs|mjs)$/.test(file)) {
            const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
            assert.equal(result.status, 0, result.stderr || `Cannot parse ${file}`);
        } else if (file.endsWith('.json')) JSON.parse(fs.readFileSync(file, 'utf8'));
    }
}

check(root);
const pkg = require('../package.json');
const manifest = require('../extension/manifest.json');
const plugin = require('../index.js');
assert.equal(pkg.name, 'sillytavern-custom-text2img');
assert.equal(plugin.info.id, pkg.name);
assert.equal(manifest.version, pkg.version);
assert.equal(typeof plugin.init, 'function');
assert.equal(typeof plugin.exit, 'function');
console.log('JavaScript syntax, JSON files, plugin exports and frontend/backend versions OK.');
