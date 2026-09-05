'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

async function main() {
    const url = new URL(process.argv[2] || 'http://127.0.0.1:8001');
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password) throw new Error('UI smoke test only accepts a non-credentialed loopback URL.');
    const options = process.argv.slice(3);
    const layout = options.find(arg => arg.startsWith('--layout='))?.slice('--layout='.length) || 'installed';
    const withoutBackend = options.includes('--without-backend');
    if (!['installed', 'repository', 'standalone'].includes(layout)
        || options.some(arg => !arg.startsWith('--layout=') && arg !== '--without-backend')) {
        throw new Error('Options: --layout=installed|repository|standalone [--without-backend]');
    }
    const { ID, RUNTIME_FILES } = require('./install-ui.cjs');
    const extensionPrefix = `/scripts/extensions/third-party/${ID}/`;
    const fixtureRoot = path.resolve(__dirname, layout === 'repository' ? '..' : '../extension');
    const fixtureFiles = new Set(['manifest.json', ...RUNTIME_FILES.map(name => layout === 'repository' ? `extension/${name}` : name)]);
    const base = '/api/plugins/sillytavern-custom-text2img';
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
    try {
        const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
        const page = await context.newPage();
        page.setDefaultTimeout(20_000);
        let blockedSettingsWrites = 0;
        const unexpectedWrites = [];
        const pageErrors = [];
        const initializationErrors = [];
        const assetResponses = new Map();
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error' && message.text().includes('[SillyTavernCustomText2Img]')) initializationErrors.push(message.text());
        });
        page.on('response', response => {
            const pathname = new URL(response.url()).pathname;
            if (pathname.startsWith(extensionPrefix)) assetResponses.set(pathname, response.status());
        });
        await context.route('**/*', async (route) => {
            const request = route.request();
            const target = new URL(request.url());
            if (!['http:', 'https:'].includes(target.protocol)) return route.continue();
            if (target.origin !== url.origin) return route.abort('blockedbyclient');
            // Test both GitHub and install-ui layouts without replacing the user's installation.
            if (layout !== 'installed' && target.pathname.startsWith(extensionPrefix)) {
                const file = target.pathname.slice(extensionPrefix.length);
                if (!fixtureFiles.has(file)) return route.fulfill({ status: 404, body: 'Unknown extension fixture asset' });
                return route.fulfill({ status: 200, path: path.join(fixtureRoot, file) });
            }
            if (target.pathname === '/api/settings/save') {
                blockedSettingsWrites++;
                return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' });
            }
            // Verify UI error handling without sending any credentials to NovelAI.
            if (target.pathname === `${base}/novelai/test`) {
                return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"UI smoke: Token 尚未儲存（模擬回應）"}' });
            }
            if (target.pathname === `${base}/presets`) {
                return route.fulfill({ status: 200, contentType: 'application/json', body: '{"presets":[]}' });
            }
            if (request.method() === 'POST' && (/\/(?:generate|generate-image|generate-stream|jobs)$/.test(target.pathname)
                || target.pathname === `${base}/novelai/token` || /^\/api\/secrets\/(?:write|delete|rotate|rename)$/.test(target.pathname))) {
                unexpectedWrites.push(target.pathname);
                return route.abort('blockedbyclient');
            }
            if (withoutBackend && target.pathname.startsWith(`${base}/`)) {
                return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"Test fixture: backend not installed"}' });
            }
            return route.continue();
        });
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        await page.locator('#cmi_settings').waitFor({ state: 'attached' });
        if (!(await page.locator('#rm_extensions_block').isVisible())) await page.locator('#extensions-settings-button > .drawer-toggle').click();
        if (!(await page.locator('#cmi_provider').isVisible())) await page.locator('#cmi_settings > .inline-drawer > .inline-drawer-toggle').click();
        assert.equal(await page.locator('#cmi_settings').count(), 1);
        const manifest = await page.evaluate(async (manifestPath) => {
            const response = await fetch(manifestPath);
            if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
            return response.json();
        }, `${extensionPrefix}manifest.json`);
        const entry = new URL(`${extensionPrefix}${manifest.js}`, url.origin);
        const requiredAssets = [
            `${extensionPrefix}manifest.json`, entry.pathname, `${extensionPrefix}${manifest.css}`,
            ...['settings.html', 'providers.js', 'generation.js'].map(file => new URL(file, entry).pathname),
        ];
        for (const asset of requiredAssets) assert.equal(assetResponses.get(asset), 200, `Browser must load ${asset}`);
        assert.ok(!assetResponses.has(`${extensionPrefix}server/novelai.js`), 'Server code must never be loaded by the browser');
        if (withoutBackend) {
            await page.locator('#cmi_plugin_warning').waitFor({ state: 'visible' });
            assert.match(await page.locator('#cmi_plugin_warning').textContent(), /網頁「安裝擴展」只安裝前端/);
            assert.deepEqual(unexpectedWrites, []);
            assert.deepEqual(pageErrors, []);
            assert.deepEqual(initializationErrors, []);
            console.log(JSON.stringify({ ok: true, url: url.origin, layout, backend: 'absent (simulated)',
                backendWarning: 'passed', requiredAssets, unexpectedWrites, blockedSettingsWrites, pageErrors, initializationErrors }, null, 2));
            return;
        }
        assert.equal(await page.locator('#cmi_plugin_warning').isVisible(), false);
        const provider = page.locator('#cmi_provider');
        const initialProvider = await provider.inputValue();
        const initialModel = await page.locator('#cmi_novel_model').inputValue();
        const initialPanel = await page.locator('#cmi_base_url').inputValue();
        const responsePromise = page.waitForResponse(response => response.url().endsWith(`${base}/novelai/status`));
        await provider.selectOption('novelai');
        const response = await responsePromise;
        assert.equal(response.status(), 200, 'The real ST SecretManager bridge must work');
        const status = await response.json();
        assert.equal(typeof status.configured, 'boolean');
        assert.equal(status.endpoint, 'https://image.novelai.net/ai/generate-image');
        assert.equal(await page.locator('[data-cmi-provider="novelai"]').isVisible(), true);
        assert.equal(await page.locator('[data-cmi-provider="comfy-modal"]').first().isVisible(), false);
        assert.equal(await page.locator('#cmi_novel_model option').count(), 6);
        assert.equal(await page.locator('#cmi_novel_token').inputValue(), '');
        await page.locator('#cmi_novel_model').selectOption('nai-diffusion-3');
        assert.equal(await page.locator('#cmi_novel_model').inputValue(), 'nai-diffusion-3');
        await page.locator('#cmi_novel_save_token').click();
        assert.match(await page.locator('#cmi_novel_status').textContent(), /請先貼上/);
        await page.locator('#cmi_novel_test').click();
        await page.waitForFunction(() => document.querySelector('#cmi_novel_status').textContent.includes('UI smoke:'));
        await provider.selectOption('comfy-modal');
        assert.equal(await page.locator('[data-cmi-provider="comfy-modal"]').first().isVisible(), true);
        assert.equal(await page.locator('#cmi_base_url').inputValue(), initialPanel);
        await provider.selectOption('novelai');
        await page.locator('#cmi_novel_model').selectOption(initialModel);
        await page.waitForFunction(() => !document.querySelector('#cmi_novel_status').textContent.includes('UI smoke:'));
        const output = path.resolve(__dirname, `../test-results/ui-smoke-${layout}.png`);
        fs.mkdirSync(path.dirname(output), { recursive: true });
        await page.locator('#cmi_settings').screenshot({ path: output });
        await provider.selectOption(initialProvider);
        assert.equal(await page.locator('#cmi_base_url').inputValue(), initialPanel);
        const legacyLoaded = await page.evaluate(() => performance.getEntriesByType('resource').some(entry => entry.name.includes('/third-party/st-comfy-modal-illustrator/')));
        assert.equal(legacyLoaded, false);
        assert.deepEqual(unexpectedWrites, []);
        assert.deepEqual(pageErrors, []);
        assert.deepEqual(initializationErrors, []);
        console.log(JSON.stringify({ ok: true, url: url.origin, layout, requiredAssets, providers: 2, modelOptions: 6, secretBridge: 'passed',
            tokenConfigured: status.configured, legacyLoaded, unexpectedWrites, blockedSettingsWrites, pageErrors, initializationErrors, screenshot: output }, null, 2));
    } finally {
        await browser.close();
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
