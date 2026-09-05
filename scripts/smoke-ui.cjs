'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require('playwright');
const { ID, RUNTIME_FILES } = require('./install-ui.cjs');

// All generated images, credentials, prompts and writes in this test are fixtures.
// The real ST UI is used, but no real generation/settings/chat write can escape.
async function main() {
    const url = new URL(process.argv[2] || 'http://127.0.0.1:8001');
    if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
        || url.username || url.password) throw new Error('UI smoke test only accepts a non-credentialed loopback URL.');
    const options = process.argv.slice(3);
    const layout = options.find(arg => arg.startsWith('--layout='))?.slice('--layout='.length) || 'repository';
    if (!['installed', 'repository', 'standalone'].includes(layout)
        || options.some(arg => !arg.startsWith('--layout=') && arg !== '--without-backend')) {
        throw new Error('Options: --layout=installed|repository|standalone [--without-backend] (backend is always blocked)');
    }
    const { PNG_BYTES, PNG_BASE64, PANEL_TOKEN, JOB_ID, makeZip } = await import('../extension/tests/fixtures.mjs');
    const extensionPrefix = `/scripts/extensions/third-party/${ID}/`;
    const fixtureRoot = path.resolve(__dirname, layout === 'repository' ? '..' : '../extension');
    const fixtureFiles = new Set(['manifest.json', ...RUNTIME_FILES.map(name => layout === 'repository' ? `extension/${name}` : name)]);
    const token = 'browser-smoke-fake-novel-token', phrase = 'browser smoke unlock phrase';
    const settingsKey = 'sillytavern_custom_text2img', password = 'browser-smoke-panel-password';
    const panelCalls = [], panelSubmissions = [], fixtureErrors = [];
    let polls = 0;
    const panel = http.createServer(async (request, response) => {
        try {
            panelCalls.push({ path: request.url, method: request.method, origin: request.headers.origin,
                cookie: Boolean(request.headers.cookie), csrf: Boolean(request.headers['x-csrf-token']) });
            const headers = { 'Access-Control-Allow-Origin': url.origin, Vary: 'Origin', 'Cache-Control': 'no-store' };
            const json = (status, body) => { response.writeHead(status, { ...headers, 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
            if (request.headers.origin !== url.origin) return json(403, { detail: 'Wrong origin' });
            if (request.headers.cookie || request.headers['x-csrf-token']) return json(403, { detail: 'ST credentials leaked' });
            if (request.method === 'OPTIONS') {
                response.writeHead(204, { ...headers, 'Access-Control-Allow-Methods': request.headers['access-control-request-method'],
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Private-Network': 'true' });
                return response.end();
            }
            const chunks = []; for await (const chunk of request) chunks.push(chunk);
            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
            if (request.url === '/api/browser/login') {
                if (body.password !== password) return json(401, { detail: 'Incorrect password' });
                return json(200, { ok: true, protocol: 1, token: PANEL_TOKEN, expires_at: Date.now() / 1000 + 3600,
                    expires_in: 3600, generation_transports: ['poll'] });
            }
            if (request.headers.authorization !== `Bearer ${PANEL_TOKEN}`) return json(401, { detail: 'Not signed in' });
            if (request.url === '/api/browser/queue') return json(200, { waiting: 0, generation_transports: ['poll'] });
            if (request.url === '/api/browser/presets') return json(200, { presets: [{ name: 'illustration' }] });
            if (request.url === '/api/browser/presets/illustration') return json(200, {
                prompts: { positive: 'masterpiece', negative: 'blurry' }, panel_values: { 'panel-fixture': { steps: 21 } },
                group_states: { SeedVR2: true }, loras: [{ name: 'fixture-lora', strength: 0.7 }], resolution: { width: 1216, height: 832 },
            });
            if (request.url === '/api/browser/generate/jobs' && request.method === 'POST') {
                panelSubmissions.push(body);
                return json(202, { job_id: JOB_ID, events: [{ type: 'accepted', generation_id: 7 }], next_cursor: 1, finished: false });
            }
            if (request.url.startsWith(`/api/browser/generate/jobs/${JOB_ID}?`)) {
                polls++;
                if (polls === 1) return json(502, { detail: 'Fixture: transient read failure' });
                if (polls === 2) return json(200, { job_id: JOB_ID, events: [{ type: 'progress', value: 1, max: 2 }], next_cursor: 2, finished: false });
                return json(200, { job_id: JOB_ID, events: [{ type: 'done', seed: '18446744073709551613', images: ['7/0.png', '7/1.png'] }], next_cursor: 3, finished: true });
            }
            if (/^\/api\/browser\/output\/7\/[01]\.png$/.test(request.url)) {
                response.writeHead(200, { ...headers, 'Content-Type': 'image/png' }); return response.end(PNG_BYTES);
            }
            return json(404, { detail: 'Unknown fixture endpoint' });
        } catch (error) {
            fixtureErrors.push(error.message);
            response.writeHead(500); response.end('Fixture failed');
        }
    });
    await new Promise(resolve => panel.listen(0, '127.0.0.1', resolve));
    const panelUrl = `http://127.0.0.1:${panel.address().port}`;
    let browser, savedVault = null, novelFormat = 'json';
    let blockedSettingsWrites = 0, savedChats = 0;
    const backendRequests = [], unexpectedWrites = [], pageErrors = [], initializationErrors = [], novelCalls = [], uploads = [];
    const assetResponses = new Map();
    try {
        browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE_PATH || undefined });
        const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
        const page = await context.newPage(); page.setDefaultTimeout(20000);
        page.on('pageerror', error => pageErrors.push(error.message));
        page.on('console', message => {
            if (message.type() === 'error' && message.text().includes('[SillyTavernCustomText2Img]')) initializationErrors.push(message.text());
        });
        page.on('response', response => {
            const pathname = new URL(response.url()).pathname;
            if (pathname.startsWith(extensionPrefix)) assetResponses.set(pathname, response.status());
        });
        // This ST fixture needs asset/write interception. Native CORS enforcement
        // is checked separately by the panel's interception-free browser smoke.
        await context.route(target => target.origin !== panelUrl, async route => {
            const request = route.request(), target = new URL(request.url());
            if (!['http:', 'https:'].includes(target.protocol)) return route.continue();
            if (target.origin === 'https://image.novelai.net') {
                if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: {
                    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': request.headers()['access-control-request-method'],
                    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
                } });
                assert.equal(request.headers().authorization, `Bearer ${token}`);
                assert.equal(request.headers().cookie, undefined);
                assert.equal(request.headers()['x-csrf-token'], undefined);
                novelCalls.push({ path: target.pathname, method: request.method(), body: request.postDataJSON() });
                const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
                if (target.pathname === '/user/subscription' && request.method() === 'GET') return route.fulfill({ status: 200, headers, json: { tier: 3, active: true } });
                if (target.pathname === '/ai/generate-image' && request.method() === 'POST') {
                    return novelFormat === 'json'
                        ? route.fulfill({ status: 200, headers, json: { images: [{ image: PNG_BASE64, seed: 0 }, { image: PNG_BASE64, seed: 1 }] } })
                        : route.fulfill({ status: 200, headers, contentType: 'application/zip', body: makeZip([{ name: '0.png', data: PNG_BYTES }, { name: '1.png', data: PNG_BYTES }]) });
                }
                unexpectedWrites.push('Unexpected NovelAI route'); return route.abort('blockedbyclient');
            }
            if (target.origin !== url.origin) return route.abort('blockedbyclient');
            if (target.pathname.startsWith('/api/plugins/')) {
                backendRequests.push(target.pathname);
                return route.fulfill({ status: 404, json: { error: 'No server plugins in browser-only fixture' } });
            }
            if (layout !== 'installed' && target.pathname.startsWith(extensionPrefix)) {
                const file = target.pathname.slice(extensionPrefix.length);
                if (!fixtureFiles.has(file)) return route.fulfill({ status: 404, body: 'Unknown fixture asset' });
                return route.fulfill({ status: 200, path: path.join(fixtureRoot, file) });
            }
            if (target.pathname === '/api/settings/get') {
                const response = await route.fetch(), body = await response.json(), settings = JSON.parse(body.settings);
                settings.extension_settings ??= {};
                settings.extension_settings[settingsKey] = { provider: 'novelai', enabled: true, profileId: 'browser-fixture-profile',
                    baseUrl: panelUrl, password, panelPreset: '', novelVault: savedVault, novelBatchSize: 2, novelSeed: '0', batchSize: 2 };
                body.settings = JSON.stringify(settings);
                return route.fulfill({ response, json: body });
            }
            if (target.pathname === '/api/settings/save') {
                blockedSettingsWrites++;
                const body = request.postDataJSON();
                savedVault = body?.extension_settings?.[settingsKey]?.novelVault ?? savedVault;
                return route.fulfill({ status: 200, json: { result: 'ok' } });
            }
            if (target.pathname === '/api/images/upload') {
                const body = request.postDataJSON();
                assert.equal(body.image, PNG_BASE64); assert.equal(body.format, 'png');
                uploads.push(body);
                return route.fulfill({ status: 200, json: { path: `/__custom-text2img-fixture__/image-${uploads.length}.png` } });
            }
            if (target.pathname.startsWith('/__custom-text2img-fixture__/')) return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES });
            // The built-in image extension reads local workflow names at startup;
            // this POST is read-only, unlike the other blocked /api/sd routes.
            if (target.pathname === '/api/sd/comfy/workflows') return route.fulfill({ status: 200, json: [] });
            if (request.method() !== 'GET' && (/\/(?:generate|generate-image|generate-stream|jobs)$/.test(target.pathname)
                || target.pathname.startsWith('/api/sd/') || /^\/api\/secrets\/(?:write|delete|rotate|rename)$/.test(target.pathname)
                || /^\/api\/(?:chats|characters|groups)\/(?:save|create|delete|edit|import)/.test(target.pathname))) {
                unexpectedWrites.push(target.pathname); return route.abort('blockedbyclient');
            }
            return route.continue();
        });

        async function openSettings() {
            if (!(await page.locator('#rm_extensions_block').isVisible())) await page.locator('#extensions-settings-button > .drawer-toggle').click();
            if (!(await page.locator('#cmi_provider').isVisible())) await page.locator('#cmi_settings > .inline-drawer > .inline-drawer-toggle').click();
        }
        async function fixtureChat() {
            // Extension assets load before APP_READY. Wait for all startup
            // listeners to finish so they cannot overwrite token status mid-test.
            await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'));
            await page.evaluate(() => {
                const original = SillyTavern.getContext.bind(SillyTavern), context = original();
                window.__cmiSmoke = { promptProfiles: [], savedChats: 0 };
                context.extensionSettings.connectionManager ??= {};
                context.extensionSettings.connectionManager.profiles = [{ id: 'browser-fixture-profile', name: 'Independent fixture profile' }];
                SillyTavern.getContext = () => ({ ...original(), name2: 'Browser fixture', characterId: 0, groupId: null,
                    getCurrentChatId: () => 'browser-only-fixture', getCharacterCardFields: () => ({ description: 'A traveler in a forest.' }),
                    saveChat: async () => { window.__cmiSmoke.savedChats++; },
                    ConnectionManagerRequestService: {
                        isProfileSupported: () => true,
                        sendRequest: async (id, _messages, _maxTokens, options) => {
                            if (!options.includePreset || !options.includeInstruct) throw new Error('Prompt profile options were lost');
                            window.__cmiSmoke.promptProfiles.push(id); return { content: 'landscape, sunrise' };
                        },
                    },
                });
                const message = { name: 'Browser fixture', is_user: false, is_system: false, send_date: new Date().toISOString(),
                    mes: 'A traveler watches sunrise over a forest clearing.', swipe_id: 0, extra: {} };
                context.chat.splice(0, context.chat.length, message);
                document.querySelector('#chat').replaceChildren();
                context.addOneMessage(message, { scroll: false, showSwipes: false });
                context.eventSource.emit(context.event_types.CHARACTER_MESSAGE_RENDERED, 0);
                context.eventSource.emit(context.event_types.CONNECTION_PROFILE_LOADED);
            });
            await page.locator('#chat .mes[mesid="0"] .cmi_message_gen').waitFor({ state: 'attached' });
        }
        async function clickGenerate(expectedImages) {
            if (await page.locator('#rm_extensions_block').isVisible()) await page.locator('#extensions-settings-button > .drawer-toggle').click();
            const message = page.locator('#chat .mes[mesid="0"]');
            if (!(await message.locator('.cmi_message_gen').isVisible())) await message.locator('.extraMesButtonsHint').click();
            await message.locator('.cmi_message_gen').click();
            await page.waitForFunction(count => SillyTavern.getContext().chat[0].extra?.media?.length === count, expectedImages);
            await page.waitForFunction(() => [...document.querySelectorAll('#chat .mes_media_wrapper img')].some(image => image.complete && image.naturalWidth > 0));
            await page.waitForFunction(() => !document.querySelector('#chat .cmi_message_gen').classList.contains('cmi_busy'));
            // Finished notification toasts may cover the next message action
            // while the test mouse is parked over them. Dismiss only after success.
            await page.mouse.move(0, 0);
            await page.evaluate(() => toastr.remove());
        }

        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        await page.locator('#cmi_settings').waitFor({ state: 'attached' });
        await fixtureChat(); await openSettings();
        assert.equal(await page.locator('#cmi_settings').count(), 1);
        assert.match(await page.locator('#cmi_install_mode').textContent(), /不需要 ST 後端/);
        assert.equal(await page.locator('#cmi_novel_model option').count(), 6);
        await page.locator('#cmi_novel_save_token').click();
        assert.match(await page.locator('#cmi_novel_status').textContent(), /請先貼上/);
        await page.locator('#cmi_novel_token').fill(token);
        await page.locator('#cmi_novel_passphrase').fill(phrase);
        const saved = page.waitForResponse(response => response.url().endsWith('/api/settings/save') && (response.request().postData() || '').includes('ciphertext'));
        await page.locator('#cmi_novel_save_token').click();
        await page.waitForFunction(() => document.querySelector('#cmi_novel_status').textContent.includes('已解鎖'));
        await saved;
        const record = await page.evaluate(key => SillyTavern.getContext().extensionSettings[key].novelVault, settingsKey);
        assert.ok(record?.ciphertext); assert.ok(!JSON.stringify(record).includes(token)); assert.ok(!JSON.stringify(record).includes(phrase));
        assert.equal(await page.locator('#cmi_novel_token').inputValue(), ''); assert.equal(await page.locator('#cmi_novel_passphrase').inputValue(), '');
        await page.locator('#cmi_novel_lock').click();
        await page.locator('#cmi_novel_passphrase').fill('incorrect unlock phrase'); await page.locator('#cmi_novel_unlock').click();
        await page.waitForFunction(() => document.querySelector('#cmi_novel_status').textContent.includes('無法解鎖'));
        await page.locator('#cmi_novel_passphrase').fill(phrase); await page.locator('#cmi_novel_unlock').click();
        await page.waitForFunction(() => document.querySelector('#cmi_novel_status').textContent.includes('已解鎖'));
        await page.locator('#cmi_novel_test').click();
        await page.waitForFunction(() => document.querySelector('#cmi_novel_status').textContent.includes('瀏覽器直連成功'));
        await clickGenerate(2);
        let media = await page.evaluate(() => SillyTavern.getContext().chat[0].extra.media);
        assert.deepEqual(media.map(image => image.seed), ['0', '1']);
        novelFormat = 'zip'; await clickGenerate(4);
        media = await page.evaluate(() => SillyTavern.getContext().chat[0].extra.media);
        assert.equal(media.length, 4); assert.equal(media[2].seed, '0'); assert.equal(media[3].seed, undefined);
        savedChats += await page.evaluate(() => window.__cmiSmoke.savedChats);
        const outputDir = path.resolve(__dirname, '../test-results'); fs.mkdirSync(outputDir, { recursive: true });
        await page.locator('#chat').screenshot({ path: path.join(outputDir, `ui-gallery-${layout}.png`) });

        // Reload proves there is no remembered plaintext token. Only encrypted fixture settings survive.
        savedVault = record;
        await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#cmi_settings').waitFor({ state: 'attached' });
        await fixtureChat(); await openSettings();
        assert.match(await page.locator('#cmi_novel_status').textContent(), /鎖定/);
        assert.equal(await page.locator('#cmi_novel_token').inputValue(), '');
        await page.locator('#cmi_novel_test').click();
        assert.match(await page.locator('#cmi_novel_status').textContent(), /先儲存並解鎖/);
        await page.locator('#cmi_provider').selectOption('comfy-modal');
        if (!(await page.locator('#cmi_test_connection').isVisible())) await page.locator('[data-cmi-provider="comfy-modal"] .inline-drawer-toggle').first().click();
        await page.locator('#cmi_test_connection').click();
        await page.waitForFunction(() => document.querySelector('#cmi_connection_status').textContent.includes('瀏覽器直連成功'));
        await page.locator('#cmi_panel_preset').selectOption('illustration');
        await page.evaluate(() => {
            const settings = SillyTavern.getContext().extensionSettings.sillytavern_custom_text2img;
            settings.seed = '18446744073709551613'; settings.batchSize = 2;
        });
        await clickGenerate(2);
        media = await page.evaluate(() => SillyTavern.getContext().chat[0].extra.media);
        assert.deepEqual(media.map(image => image.seed), ['18446744073709551613', '18446744073709551613']);
        assert.equal(media[0].negative, 'blurry');
        assert.equal(panelSubmissions.length, 1, 'A failed read must not resubmit generation');
        assert.equal(panelSubmissions[0].seed, '18446744073709551613');
        assert.equal(panelSubmissions[0].batch_size, 2); assert.equal(panelSubmissions[0].loras[0].name, 'fixture-lora');
        assert.equal(panelSubmissions[0].group_states.SeedVR2, true); assert.equal(panelSubmissions[0].panel_values['panel-fixture'].steps, 21);
        assert.equal(panelSubmissions[0].width, 1216); assert.equal(panelSubmissions[0].height, 832);
        assert.match(panelSubmissions[0].prompt_text, /^masterpiece, landscape/);
        assert.ok(panelCalls.some(call => call.path === '/api/browser/login'), 'The browser must call the external panel API, not ST');
        assert.ok(panelCalls.every(call => call.origin === url.origin && !call.cookie && !call.csrf));
        const profiles = await page.evaluate(() => window.__cmiSmoke.promptProfiles);
        assert.deepEqual(profiles, ['browser-fixture-profile']);
        savedChats += await page.evaluate(() => window.__cmiSmoke.savedChats);
        assert.equal(savedChats, 3); assert.equal(uploads.length, 6);
        assert.equal(novelCalls.filter(call => call.path === '/ai/generate-image').length, 2);
        assert.equal(novelCalls.filter(call => call.path === '/user/subscription').length, 1);
        for (const call of novelCalls.filter(call => call.body)) {
            assert.equal(call.body.parameters.n_samples, 2); assert.equal(call.body.parameters.seed, 0);
            assert.equal(call.body.parameters.cfg_rescale, 0); assert.ok(!JSON.stringify(call.body).includes(password));
        }
        await openSettings(); await page.locator('#cmi_provider').selectOption('novelai');
        await page.locator('#cmi_settings').screenshot({ path: path.join(outputDir, `ui-smoke-${layout}.png`) });
        const manifest = await page.evaluate(async prefix => (await fetch(prefix + 'manifest.json')).json(), extensionPrefix);
        assert.equal(manifest.version, require('../package.json').version);
        const entry = new URL(extensionPrefix + manifest.js, url.origin);
        const requiredAssets = [extensionPrefix + 'manifest.json', extensionPrefix + manifest.css,
            ...RUNTIME_FILES.filter(file => file.endsWith('.js') || file === 'settings.html').map(file => new URL(file, entry).pathname)];
        for (const asset of requiredAssets) assert.equal(assetResponses.get(asset), 200, `Browser must load ${asset}`);
        assert.deepEqual(backendRequests, []); assert.deepEqual(unexpectedWrites, []); assert.deepEqual(fixtureErrors, []);
        assert.deepEqual(pageErrors, []); assert.deepEqual(initializationErrors, []);
        console.log(JSON.stringify({ ok: true, url: url.origin, layout, backend: 'all /api/plugins requests blocked; none made',
            nativeGalleryImages: uploads.length, savedChats, novelai: ['JSON', 'ZIP', 'batch', 'encrypted vault', 'reload locks', 'read-only token test'],
            panel: ['direct browser API wiring (fixture)', 'short-lived bearer', 'presets/LoRA/overrides', '64-bit seed', 'retry reads only'],
            panelPreflights: panelCalls.filter(call => call.method === 'OPTIONS').length, panelSubmissions: panelSubmissions.length,
            requiredAssets, blockedSettingsWrites, pageErrors, initializationErrors }, null, 2));
    } finally {
        if (browser) await browser.close();
        panel.closeAllConnections(); await new Promise(resolve => panel.close(resolve));
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
