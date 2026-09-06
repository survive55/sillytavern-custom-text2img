'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
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
    const fixtureBody = 'A traveler watches sunrise over a forest clearing.';
    const fixturePlan = JSON.stringify({ scenes: [{ after: fixtureBody, label: 'Sunrise', prompt: 'landscape, sunrise' }] });
    const makeMessage = (mes = fixtureBody) => ({ name: 'Browser fixture', is_user: false, is_system: false,
        send_date: new Date().toISOString(), mes, swipe_id: 0, extra: {} });
    const panelCalls = [], panelSubmissions = [], manualLlmCalls = [], fixtureErrors = [];
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
    const manualLlmServer = http.createServer(async (request, response) => {
        try {
            manualLlmCalls.push({ method: request.method, path: request.url, origin: request.headers.origin,
                requestedHeaders: request.headers['access-control-request-headers'] || '',
                privateNetwork: request.headers['access-control-request-private-network'] || '',
                authorization: request.headers.authorization, cookie: request.headers.cookie, csrf: request.headers['x-csrf-token'] });
            const cors = { 'Access-Control-Allow-Origin': url.origin, Vary: 'Origin', 'Cache-Control': 'no-store' };
            if (request.url === '/cors-denied') { response.writeHead(200, { 'Content-Type': 'text/plain' }); return response.end('no cors'); }
            if (request.headers.origin !== url.origin || request.headers.cookie || request.headers['x-csrf-token']) {
                response.writeHead(403, { ...cors, 'Content-Type': 'application/json' });
                return response.end(JSON.stringify({ error: 'Invalid browser request' }));
            }
            if (request.method === 'OPTIONS') {
                response.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'POST',
                    'Access-Control-Allow-Headers': request.headers['access-control-request-headers'] || 'Authorization, Content-Type',
                    'Access-Control-Allow-Private-Network': 'true' });
                return response.end();
            }
            assert.equal(request.method, 'POST'); assert.equal(request.url, '/v1/chat/completions');
            assert.equal(request.headers.authorization, 'Bearer browser-smoke-manual-key');
            assert.equal(request.headers['x-cmi-smoke'], 'native-cors');
            const chunks = []; for await (const chunk of request) chunks.push(chunk);
            const body = JSON.parse(Buffer.concat(chunks).toString());
            manualLlmCalls[manualLlmCalls.length - 1].body = body;
            response.writeHead(200, { ...cors, 'Content-Type': 'application/json' });
            const isConnectionTest = body.messages?.length === 1 && body.messages[0].content === 'Reply with exactly: OK';
            response.end(JSON.stringify({ choices: [{ message: { content: isConnectionTest ? 'OK' : fixturePlan } }] }));
        } catch (error) {
            fixtureErrors.push(error.message); response.writeHead(500); response.end('Manual LLM fixture failed');
        }
    });
    await Promise.all([
        new Promise(resolve => panel.listen(0, '127.0.0.1', resolve)),
        new Promise(resolve => manualLlmServer.listen(0, '127.0.0.1', resolve)),
    ]);
    const panelUrl = `http://127.0.0.1:${panel.address().port}`;
    const manualLlmOrigin = `http://localhost:${manualLlmServer.address().port}`;
    let browser, savedVault = null, savedLlm = null, novelFormat = 'json';
    let blockedSettingsWrites = 0, blockedStartupWrites = 0, savedChats = 0, delayedFixtureImages = 0;
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
        await context.route(target => ![panelUrl, manualLlmOrigin].includes(target.origin), async route => {
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
                settings.extension_settings[settingsKey] = { provider: 'novelai', enabled: true, promptConnectionMode: 'profile', profileId: 'browser-fixture-profile',
                    manualLlmBaseUrl: `${manualLlmOrigin}/v1`, manualLlmPath: 'chat/completions', manualLlmModel: 'browser-smoke-model',
                    manualLlmApiKey: 'browser-smoke-manual-key', manualLlmApiKeyHeader: 'Authorization', manualLlmApiKeyPrefix: 'Bearer', manualLlmExtraHeaders: '{"X-CMI-Smoke":"native-cors"}',
                    baseUrl: panelUrl, password, panelPreset: '', novelVault: savedVault, novelBatchSize: 2, novelSeed: '0', batchSize: 2, ...savedLlm };
                body.settings = JSON.stringify(settings);
                return route.fulfill({ response, json: body });
            }
            if (target.pathname === '/api/settings/save') {
                blockedSettingsWrites++;
                const body = request.postDataJSON();
                const fixtureSettings = body?.extension_settings?.[settingsKey];
                savedVault = fixtureSettings?.novelVault ?? savedVault;
                if (fixtureSettings?.llmPresets) savedLlm = { llmPresets: fixtureSettings.llmPresets,
                    llmPresetId: fixtureSettings.llmPresetId, promptPresetMode: fixtureSettings.promptPresetMode };
                return route.fulfill({ status: 200, json: { result: 'ok' } });
            }
            if (target.pathname === '/api/images/upload') {
                const body = request.postDataJSON();
                assert.equal(body.image, PNG_BASE64); assert.equal(body.format, 'png');
                uploads.push(body);
                return route.fulfill({ status: 200, json: { path: `/user/images/__cmi_fixture__/Browser fixture/image-${uploads.length}.png` } });
            }
            if (target.pathname.startsWith('/user/images/__cmi_fixture__/')) {
                if (target.pathname.includes('/delayed-legacy/')) {
                    delayedFixtureImages++;
                    // Exercise ST's deferred native-gallery write after migration
                    // has already removed these duplicates from extra.media.
                    await new Promise(resolve => setTimeout(resolve, 125));
                }
                return route.fulfill({ status: 200, contentType: 'image/png', body: PNG_BYTES });
            }
            // Built-in ST startup requests are fixtures too: quick-reply
            // migration must never write presets and Horde must not query upstream.
            if (request.method() === 'POST') {
                if (target.pathname === '/api/quick-replies/save') {
                    blockedStartupWrites++;
                    return route.fulfill({ status: 200, contentType: 'text/plain', body: 'OK' });
                }
                if (target.pathname === '/api/horde/status') return route.fulfill({ status: 200, json: { ok: false } });
                if (target.pathname === '/api/horde/text-models') return route.fulfill({ status: 200, json: [] });
                if (target.pathname === '/api/image-metadata/all') return route.fulfill({ status: 200, json: { version: 1, images: {} } });
            }
            // The built-in image extension reads local workflow names at startup;
            // this POST is read-only, unlike the other blocked /api/sd routes.
            if (target.pathname === '/api/sd/comfy/workflows') return route.fulfill({ status: 200, json: [] });
            if (request.method() !== 'GET' && (/\/(?:generate|generate-image|generate-stream|jobs)$/.test(target.pathname)
                || target.pathname.startsWith('/api/sd/') || /^\/api\/secrets\/(?:write|delete|rotate|rename)$/.test(target.pathname)
                || /^\/api\/(?:chats|characters|groups)\/(?:save|create|delete|edit|import)/.test(target.pathname))) {
                unexpectedWrites.push(target.pathname); return route.abort('blockedbyclient');
            }
            // Fail closed for every other mutation, even if a future ST version
            // introduces an endpoint not covered by the explicit guards above.
            const readOnlyPosts = new Set(['/api/characters/all', '/api/characters/get', '/api/characters/chats',
                '/api/backgrounds/all', '/api/backgrounds/folders', '/api/avatars/get', '/api/groups/all',
                '/api/chats/get', '/api/chats/group/get', '/api/chats/recent', '/api/worldinfo/get', '/api/worldinfo/list',
                '/api/secrets/read', '/api/stats/get']);
            if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())
                && !(request.method() === 'POST' && readOnlyPosts.has(target.pathname))) {
                unexpectedWrites.push(`${request.method()} ${target.pathname}`); return route.abort('blockedbyclient');
            }
            return route.continue();
        });

        async function openSettings() {
            if (!(await page.locator('#rm_extensions_block').isVisible())) await page.locator('#extensions-settings-button > .drawer-toggle').click();
            if (!(await page.locator('#cmi_provider').isVisible())) await page.locator('#cmi_settings > .inline-drawer > .inline-drawer-toggle').click();
        }
        async function openPromptSettings() {
            await openSettings();
            if (!(await page.locator('#cmi_prompt_connection_mode').isVisible())) {
                await page.locator('#cmi_prompt_section > .inline-drawer-toggle').click();
            }
        }
        async function fixtureChat() {
            // Extension assets load before APP_READY. Wait for all startup
            // listeners to finish so they cannot overwrite token status mid-test.
            await page.waitForFunction(() => window.SillyTavern?.getContext().eventSource.autoFireLastArgs.has('app_ready'));
            await page.evaluate(({ initialMessage, initialPlan }) => {
                const original = SillyTavern.getContext.bind(SillyTavern), context = original();
                window.__cmiPlanReply = initialPlan;
                window.__cmiSmoke = { promptProfiles: [], promptRequests: [], savedChats: 0 };
                context.extensionSettings.connectionManager ??= {};
                context.extensionSettings.connectionManager.profiles = [{ id: 'browser-fixture-profile', name: 'Independent fixture profile', api: 'fixture-cc' }];
                SillyTavern.getContext = () => ({ ...original(), name2: 'Browser fixture', characterId: 0, groupId: null,
                    getCurrentChatId: () => 'browser-only-fixture', getCharacterCardFields: () => ({ description: 'A traveler in a forest.' }),
                    characters: [{ name: 'Browser fixture', description: 'A traveler in a forest.' }],
                    CONNECT_API_MAP: { ...context.CONNECT_API_MAP, 'fixture-cc': { selected: 'openai' } },
                    saveChat: async () => { window.__cmiSmoke.savedChats++; window.__cmiSmoke.savedMessage = structuredClone(original().chat[0]); },
                    ConnectionManagerRequestService: {
                        isProfileSupported: () => true,
                        sendRequest: async (id, messages, maxTokens, options, parameters) => {
                            if (!options.includePreset) throw new Error('Trusted profile preset was lost');
                            window.__cmiSmoke.promptRequests.push({ messages, maxTokens, parameters, includeInstruct: options.includeInstruct });
                            window.__cmiSmoke.promptProfiles.push(id); return { content: window.__cmiPlanReply };
                        },
                    },
                });
                context.chat.splice(0, context.chat.length, initialMessage);
                document.querySelector('#chat').replaceChildren();
                context.addOneMessage(initialMessage, { scroll: false, showSwipes: false });
                context.eventSource.emit(context.event_types.CHARACTER_MESSAGE_RENDERED, 0);
                context.eventSource.emit(context.event_types.CONNECTION_PROFILE_LOADED);
            }, { initialMessage: makeMessage(), initialPlan: fixturePlan });
            await page.locator('#chat .mes[mesid="0"] .cmi_message_analyze').waitFor({ state: 'attached' });
            await assertNoLegacyWand();
        }
        async function renderFixture(message) {
            await page.evaluate(message => {
                const context = SillyTavern.getContext(); context.chat[0] = message;
                context.updateMessageBlock(0, message); context.eventSource.emit(context.event_types.CHAT_CHANGED);
            }, message);
        }
        async function closeSettings() {
            if (await page.locator('#rm_extensions_block').isVisible()) await page.locator('#extensions-settings-button > .drawer-toggle').click();
            await page.locator('#rm_extensions_block').waitFor({ state: 'hidden' });
        }
        async function dismissToasts() {
            // Finished notification toasts can cover the next real click.
            await page.mouse.move(0, 0); await page.evaluate(() => toastr.remove());
        }
        async function assertNoLegacyWand() {
            assert.equal(await page.locator('#chat .cmi_message_gen').count(), 0, 'The old whole-message magic wand must not exist');
        }
        async function assertNoBottomImages() {
            assert.deepEqual(await page.evaluate(() => SillyTavern.getContext().chat[0].extra?.media ?? []), [],
                'Inline generation must not append to the native gallery');
            assert.equal(await page.locator('#chat .mes_media_wrapper img').count(), 0, 'No duplicate bottom-gallery images');
            await assertNoLegacyWand();
        }
        async function analyzeMessage(expectedSlots = 1) {
            await closeSettings(); await dismissToasts();
            const floor = page.locator('#chat .mes[mesid="0"]');
            if (!(await floor.locator('.cmi_message_analyze').isVisible())) await floor.locator('.extraMesButtonsHint').click();
            const before = { images: uploads.length, panel: panelSubmissions.length, novel: novelCalls.length,
                saves: await page.evaluate(() => window.__cmiSmoke.savedChats) };
            await floor.locator('.cmi_message_analyze').click();
            await page.waitForFunction(({ count, saves }) => {
                const buttons = [...document.querySelectorAll('#chat .cmi-inline-generate')];
                return buttons.length === count && buttons.every(button => !button.disabled)
                    && !document.querySelector('#chat .cmi_message_analyze').classList.contains('cmi_busy')
                    && window.__cmiSmoke.savedChats === saves + 1;
            }, { count: expectedSlots, saves: before.saves });
            assert.equal(uploads.length, before.images); assert.equal(panelSubmissions.length, before.panel);
            assert.equal(novelCalls.length, before.novel, 'Analysis must not use image-provider APIs');
            await assertNoBottomImages(); await dismissToasts();
        }
        async function clickGenerate(scene = 0, expectedMedia = 2) {
            await closeSettings(); await dismissToasts();
            const saves = await page.evaluate(() => window.__cmiSmoke.savedChats);
            await page.locator('#chat .mes[mesid="0"] .cmi-inline-generate').nth(scene).click();
            await page.waitForFunction(({ scene, count, saves }) => {
                const slot = SillyTavern.getContext().chat[0].extra.cmi_inline_scenes.slots[scene];
                return slot.media?.length === count && slot.images.length === 2 && window.__cmiSmoke.savedChats === saves + 1
                    && [...document.querySelectorAll('#chat .cmi-inline-generate')].every(button => !button.disabled);
            }, { scene, count: expectedMedia, saves });
            await page.waitForFunction(scene => [...document.querySelectorAll('#chat .cmi-inline-scene')[scene].querySelectorAll('img')]
                .every(image => image.complete && image.naturalWidth > 0), scene);
            await assertNoBottomImages(); await dismissToasts();
        }

        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        const corsBypassed = await page.evaluate(async origin => {
            try { await fetch(`${origin}/cors-denied`, { mode: 'cors' }); return true; } catch { return false; }
        }, manualLlmOrigin);
        assert.equal(corsBypassed, false, 'The browser must enforce cross-origin response headers');
        await page.locator('#cmi_settings').waitFor({ state: 'attached' });
        await fixtureChat(); await openPromptSettings();
        assert.equal(await page.locator('#cmi_settings').count(), 1);
        assert.match(await page.locator('#cmi_install_mode').textContent(), /不需要 ST 後端/);
        assert.equal(await page.locator('#cmi_novel_model option').count(), 6);
        await page.locator('#cmi_prompt_connection_mode').selectOption('manual');
        await page.locator('#cmi_manual_llm_test').click();
        await page.waitForFunction(() => document.querySelector('#cmi_manual_llm_status').textContent.includes('連線成功'));
        assert.equal(await page.locator('#cmi_manual_llm_model').inputValue(), 'browser-smoke-model');
        await page.locator('#cmi_prompt_connection_mode').selectOption('profile');
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
        await analyzeMessage(); await clickGenerate();
        let media = await page.evaluate(() => SillyTavern.getContext().chat[0].extra.cmi_inline_scenes.slots[0].media);
        assert.deepEqual(media.map(image => image.seed), ['0', '1']);
        await openSettings();
        await page.locator('#cmi_log_panel > summary').click();
        await page.waitForFunction(() => document.querySelector('#cmi_log_output').textContent.includes('[complete]'));
        assert.equal(await page.locator('#cmi_log_detail').isChecked(), false);
        const defaultLogs = await page.locator('#cmi_log_output').textContent();
        assert.match(defaultLogs, /jobId/);
        assert.doesNotMatch(defaultLogs, /landscape|sunrise|forest clearing|browser-smoke-fake-novel-token|browser-smoke-panel-password|browser-smoke-manual-key/);
        assert.ok(!defaultLogs.includes(PNG_BASE64));
        await page.locator('#cmi_log_detail').check();
        // Import actual ST JSON through the file input, then generate through
        // the native-CORS manual API. No paid network call is possible.
        await openPromptSettings();
        const oldTemplate = await page.locator('#cmi_system_prompt').inputValue();
        await page.locator('#cmi_prompt_preset_mode').selectOption('preset');
        const presetJson = JSON.stringify({ temperature: 0.25, top_p: 0.8, openai_max_tokens: 777,
            custom_url: 'https://untrusted.invalid', custom_model: 'not-used',
            prompts: [{ identifier: 'phi', role: 'user', content: 'Output tags only' },
                { identifier: 'off', role: 'unknown', content: 'NEVER SENT', enabled: true },
                { identifier: 'prompt-off', role: 'system', content: 'PROMPT OFF', enabled: false },
                { identifier: 'in-chat-off', role: 'user', content: 'DEPTH OFF', enabled: false, injection_position: 1, injection_depth: 0 },
                { identifier: 'prefill', role: 'model', content: 'landscape,' },
                { identifier: 'unlisted', role: 'model', content: 'UNLISTED' },
                { identifier: 'in-chat', role: 'model', content: 'IGNORED IN-CHAT', injection_position: 1, injection_depth: 0 },
                { identifier: 'main', role: 'system', content: 'Illustrate {{char}}: {{description}}' },
                { identifier: 'chatHistory', marker: true }],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'main', enabled: true },
                { identifier: 'off', enabled: false }, { identifier: 'chatHistory', enabled: true },
                { identifier: 'phi', enabled: true }, { identifier: 'prefill', enabled: true }, { identifier: 'in-chat', enabled: true },
                { identifier: 'prompt-off', enabled: true }, { identifier: 'in-chat-off', enabled: true }] }],
        });
        await page.locator('#cmi_llm_preset_file').setInputFiles({ name: 'image-preset.json', mimeType: 'application/json', buffer: Buffer.from(presetJson) });
        await page.waitForFunction(() => document.querySelector('#cmi_llm_preset_status').textContent.includes('已選用：image-preset'));
        const selectedPreset = await page.locator('#cmi_llm_preset').inputValue();
        const readSavedRoles = () => page.evaluate(key => {
            const settings = SillyTavern.getContext().extensionSettings[key];
            return settings.llmPresets.find(record => record.id === settings.llmPresetId).preset.prompts
                .filter(item => ['off', 'prefill', 'unlisted', 'in-chat'].includes(item.identifier))
                .map(item => [item.identifier, item.role]);
        }, settingsKey);
        const expectedRoles = [['off', 'unknown'], ['prefill', 'model'], ['unlisted', 'model'], ['in-chat', 'model']];
        assert.deepEqual(await readSavedRoles(), expectedRoles, 'Import must preserve all roles');
        const assertOrderActivationState = async () => {
            assert.match(await page.locator('#cmi_llm_preset_status').textContent(), /啟用 7 項／停用 1 項，未列入順序 1 項/);
            const flags = await page.evaluate(key => {
                const settings = SillyTavern.getContext().extensionSettings[key];
                const preset = settings.llmPresets.find(record => record.id === settings.llmPresetId).preset;
                return ['prompt-off', 'in-chat-off'].map(id => [preset.prompts.find(item => item.identifier === id).enabled,
                    preset.prompt_order[0].order.find(item => item.identifier === id).enabled]);
            }, settingsKey);
            assert.deepEqual(flags, [[false, true], [false, true]], 'Both source flags must survive import and reload');
        };
        await assertOrderActivationState();
        assert.equal(await page.locator('#cmi_llm_preset_order').inputValue(), '100001');
        // Bad imports do not replace the selection or any template.
        await page.locator('#cmi_llm_preset_file').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
        await page.waitForFunction(() => document.querySelector('#cmi_llm_preset_status').textContent.includes('有效的 JSON'));
        assert.equal(await page.locator('#cmi_llm_preset').inputValue(), selectedPreset);
        await page.locator('#cmi_prompt_preset_mode').selectOption('template');
        assert.equal(await page.locator('#cmi_system_prompt').inputValue(), oldTemplate);
        await page.locator('#cmi_prompt_preset_mode').selectOption('preset');
        await page.locator('#cmi_prompt_connection_mode').selectOption('manual');
        await renderFixture(makeMessage());
        await analyzeMessage();
        novelFormat = 'zip'; await clickGenerate();
        const generatedRequest = manualLlmCalls.filter(call => call.method === 'POST').at(-1).body;
        assert.deepEqual(generatedRequest.messages.slice(0, -1), [
            { role: 'system', content: 'Illustrate Browser fixture: A traveler in a forest.' },
            { role: 'assistant', content: 'A traveler watches sunrise over a forest clearing.' },
            { role: 'model', content: 'landscape,' },
            { role: 'system', content: 'PROMPT OFF' },
        ]);
        assert.equal(generatedRequest.messages.at(-1).role, 'system');
        assert.match(generatedRequest.messages.at(-1).content, /ILLUSTRATION PLAN TASK/);
        assert.ok(generatedRequest.messages.at(-1).content.endsWith(JSON.stringify(fixtureBody)));
        assert.equal(generatedRequest.max_tokens, 2400, 'Analysis uses the dedicated budget, not preset 777');
        assert.equal(generatedRequest.temperature, 0.25);
        assert.equal(generatedRequest.top_p, 0.8); assert.equal(generatedRequest.model, 'browser-smoke-model');
        assert.ok(savedLlm?.llmPresets?.length === 1, 'The imported preset must reach fixture settings persistence');
        media = await page.evaluate(() => SillyTavern.getContext().chat[0].extra.cmi_inline_scenes.slots[0].media);
        assert.equal(media.length, 2); assert.equal(media[0].seed, '0'); assert.equal(media[1].seed, undefined);
        assert.deepEqual(media.map(item => [item.type, item.source, item.title]),
            [['image', 'generated', 'landscape, sunrise'], ['image', 'generated', 'landscape, sunrise']]);
        savedChats += await page.evaluate(() => window.__cmiSmoke.savedChats);
        assert.equal(savedChats, 4, 'Each initial analysis and slot generation saves separately');
        // Keep smoke artifacts outside the checkout.
        const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmi-smoke-ui-'));
        await page.locator('#chat').screenshot({ path: path.join(outputDir, `ui-inline-${layout}.png`) });
        await openSettings();
        await page.waitForFunction(() => document.querySelector('#cmi_log_output').textContent.includes('[image.request]'));
        const detailedLogs = await page.locator('#cmi_log_output').textContent();
        assert.match(detailedLogs, /llm.request/); assert.match(detailedLogs, /llm.response/);
        assert.match(detailedLogs, /Illustrate Browser fixture/);
        assert.match(detailedLogs, /PROMPT OFF/); assert.doesNotMatch(detailedLogs, /DEPTH OFF|Output tags only/);
        for (const secret of [token, phrase, password, 'browser-smoke-manual-key', PANEL_TOKEN, PNG_BASE64]) assert.ok(!detailedLogs.includes(secret));
        await page.locator('#cmi_log_filter').selectOption('debug');
        assert.equal(await page.locator('#cmi_log_output .cmi-log-info').count(), 0);
        // Clipboard is isolated to this fixture: never replace the user's system clipboard.
        await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true,
            value: { writeText: async text => { window.__cmiCopiedLogs = text; } } }));
        await page.locator('#cmi_log_copy').click();
        const copiedLogs = await page.evaluate(() => window.__cmiCopiedLogs);
        assert.match(copiedLogs, /llm.request/); assert.doesNotMatch(copiedLogs, /\] INFO /);
        const downloadPromise = page.waitForEvent('download');
        await page.locator('#cmi_log_download').click();
        const download = await downloadPromise;
        assert.match(download.suggestedFilename(), /^custom-text2img-logs-.*\.txt$/);
        const downloadText = fs.readFileSync(await download.path(), 'utf8');
        assert.match(downloadText, /llm.request/); assert.ok(!downloadText.includes(token));
        await page.locator('#cmi_log_filter').selectOption('all');
        const firstRun = await page.locator('#cmi_log_run option').nth(1).getAttribute('value');
        await page.locator('#cmi_log_run').selectOption(firstRun);
        assert.ok((await page.locator('#cmi_log_output pre').allTextContents()).every(text => text.includes(`[${firstRun} ·`)));
        await page.locator('#cmi_log_run').selectOption('');
        await page.locator('#cmi_log_panel').screenshot({ path: path.join(outputDir, `ui-logs-${layout}.png`) });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.locator('#cmi_log_panel').screenshot({ path: path.join(outputDir, `ui-logs-mobile-${layout}.png`) });
        const fits = await page.locator('#cmi_log_panel').evaluate(el => el.scrollWidth <= el.clientWidth + 1);
        assert.equal(fits, true, 'Log panel must not overflow on mobile');
        await page.setViewportSize({ width: 1440, height: 1080 });

        // Reload proves there is no remembered plaintext token. Only encrypted fixture settings survive.
        savedVault = record;
        await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#cmi_settings').waitFor({ state: 'attached' });
        await fixtureChat(); await openPromptSettings();
        assert.equal(await page.locator('#cmi_log_detail').isChecked(), false, 'Reload must disable detailed logging');
        assert.doesNotMatch(await page.locator('#cmi_log_output').textContent(), /llm.request|image.request|\[complete\]/, 'Reload must discard previous logs');
        assert.equal(await page.locator('#cmi_prompt_preset_mode').inputValue(), 'preset');
        assert.equal(await page.locator('#cmi_llm_preset').inputValue(), selectedPreset);
        assert.deepEqual(await readSavedRoles(), expectedRoles, 'Generation and reload must preserve saved roles');
        await assertOrderActivationState();
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
        await analyzeMessage(); await clickGenerate();
        media = await page.evaluate(() => SillyTavern.getContext().chat[0].extra.cmi_inline_scenes.slots[0].media);
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
        const profileRequest = await page.evaluate(() => window.__cmiSmoke.promptRequests[0]);
        assert.deepEqual(profileRequest.messages, generatedRequest.messages);
        assert.equal(profileRequest.maxTokens, 2400); assert.equal(profileRequest.parameters.temperature, 0.25);
        assert.equal(profileRequest.parameters.top_p, 0.8);
        assert.equal(profileRequest.includeInstruct, false);
        savedChats += await page.evaluate(() => window.__cmiSmoke.savedChats);
        assert.equal(savedChats, 6); assert.equal(uploads.length, 6);
        assert.equal(novelCalls.filter(call => call.path === '/ai/generate-image').length, 2);
        assert.equal(novelCalls.filter(call => call.path === '/user/subscription').length, 1);
        const manualPreflight = manualLlmCalls.find(call => call.method === 'OPTIONS');
        const manualPost = manualLlmCalls.find(call => call.method === 'POST');
        if (manualPreflight) {
            assert.match(manualPreflight.requestedHeaders, /authorization/i);
            assert.match(manualPreflight.requestedHeaders, /x-cmi-smoke/i);
        }
        assert.ok(manualPost); assert.equal(manualPost.authorization, 'Bearer browser-smoke-manual-key');
        assert.equal(manualPost.cookie, undefined); assert.equal(manualPost.csrf, undefined);
        assert.equal(manualPost.body.model, 'browser-smoke-model');
        assert.deepEqual(manualPost.body.messages, [{ role: 'user', content: 'Reply with exactly: OK' }]);
        for (const call of novelCalls.filter(call => call.body)) {
            assert.equal(call.body.parameters.n_samples, 2); assert.equal(call.body.parameters.seed, 0);
            assert.equal(call.body.parameters.cfg_rescale, 0); assert.ok(!JSON.stringify(call.body).includes(password));
        }
        await openSettings();
        await page.locator('#cmi_log_panel > summary').click();
        await page.waitForFunction(() => document.querySelector('#cmi_log_output').textContent.includes('[complete]'));
        assert.match(await page.locator('#cmi_log_output').textContent(), /重試查詢同一任務/);
        await page.locator('#cmi_log_filter').selectOption('problems');
        assert.ok(await page.locator('#cmi_log_output .cmi-log-warn').count());
        assert.ok(await page.locator('#cmi_log_output .cmi-log-error').count(), 'Locked token test must retain an error');
        assert.equal(await page.locator('#cmi_log_detail').isChecked(), false);
        const visibleErrors = await page.locator('#cmi_log_output .cmi-log-error').allTextContents();
        assert.match(visibleErrors.join('\n'), /請先儲存並解鎖 NovelAI Token/);
        assert.doesNotMatch(visibleErrors.join('\n'), /原始錯誤僅在詳細模式|原始錯誤（詳細模式）/);
        assert.ok(!visibleErrors.join('\n').includes(token), 'Errors still redact credentials');
        await page.locator('#cmi_log_clear').click();
        await page.waitForFunction(() => document.querySelector('#cmi_log_summary').textContent.includes('0 / 0'));
        assert.equal(await page.locator('#cmi_log_output pre').count(), 0);
        await page.locator('#cmi_provider').selectOption('novelai');
        await page.locator('#cmi_settings').screenshot({ path: path.join(outputDir, `ui-smoke-${layout}.png`) });
        // Multi-scene planning is manual and independent of image submission.
        await page.locator('#cmi_provider').selectOption('comfy-modal');
        await closeSettings();
        const inlineMessage = makeMessage('**A traveler enters the forest.**\n\nSunset lights the lake.');
        inlineMessage.swipes = [inlineMessage.mes, 'OTHER SWIPE'];
        inlineMessage.swipe_info = [{}, { extra: { untouched: 'inactive swipe' } }];
        await renderFixture(inlineMessage);
        await page.evaluate(() => {
            window.__cmiPlanReply = JSON.stringify({ scenes: [
                { after: '**A traveler enters the forest.**', label: 'Forest <img src=x onerror=alert(1)>', prompt: '1girl, forest, walking' },
                { after: 'Sunset lights the lake.', label: 'Lake', prompt: 'lake, sunset' },
            ] });
        });
        const floor = page.locator('#chat .mes[mesid="0"]');
        const promptCount = await page.evaluate(() => window.__cmiSmoke.promptRequests.length);
        const chatsBeforePlan = await page.evaluate(() => window.__cmiSmoke.savedChats);
        await floor.locator('.cmi_message_analyze').evaluate(button => button.click());
        assert.equal(await page.evaluate(() => window.__cmiSmoke.promptRequests.length), promptCount, 'Synthetic analysis clicks do not call the LLM');
        await analyzeMessage(2);
        assert.equal(panelSubmissions.length, 1, 'Analysis only creates buttons, no image request');
        assert.equal(await page.evaluate(() => window.__cmiSmoke.promptRequests.length), promptCount + 1);
        assert.equal(await floor.locator('.mes_text strong').textContent(), 'A traveler enters the forest.');
        assert.equal(await floor.locator('.cmi-inline-scene img').count(), 0, 'LLM label HTML must remain text');
        assert.match(await floor.locator('.cmi-inline-generate').first().textContent(), /<img src=x onerror=alert\(1\)>/);
        await floor.locator('.cmi-inline-generate').first().evaluate(button => button.click());
        assert.equal(panelSubmissions.length, 1, 'Synthetic image clicks do not submit');
        for (let scene = 0; scene < 2; scene++) {
            await clickGenerate(scene);
            assert.equal(panelSubmissions.length, scene + 2);
            assert.match(panelSubmissions.at(-1).prompt_text, scene ? /lake, sunset/ : /1girl, forest, walking/);
            assert.equal(await page.evaluate(() => window.__cmiSmoke.promptRequests.length), promptCount + 1, 'Stored scene prompts do not recall the LLM');
            const slots = await page.evaluate(() => SillyTavern.getContext().chat[0].extra.cmi_inline_scenes.slots);
            assert.deepEqual(slots[scene].media.map(item => item.title), Array(2).fill(slots[scene].prompt));
            if (scene === 0) assert.equal(slots[1].images.length, 0, 'Generating one location must not fill another');
        }
        assert.equal(await floor.locator('.cmi-inline-scene img').count(), 4);
        const beforeRegeneration = await page.evaluate(() => structuredClone(SillyTavern.getContext().chat[0]));
        assert.match(await floor.locator('.cmi-inline-generate').first().textContent(), /^重新生成/);
        await clickGenerate(0, 4);
        assert.equal(panelSubmissions.length, 4, 'Regenerate submits exactly one new image job');
        assert.match(panelSubmissions.at(-1).prompt_text, /1girl, forest, walking/);
        assert.equal(await page.evaluate(() => window.__cmiSmoke.promptRequests.length), promptCount + 1, 'Regenerate never recalls the LLM');
        let persisted = await page.evaluate(() => JSON.parse(JSON.stringify(window.__cmiSmoke.savedMessage)));
        const slots = persisted.extra.cmi_inline_scenes.slots;
        assert.equal(persisted.mes, beforeRegeneration.mes, 'Regenerate must not rewrite the story or marker IDs');
        assert.notDeepEqual(slots[0].images, beforeRegeneration.extra.cmi_inline_scenes.slots[0].images);
        assert.deepEqual(slots[0].media.slice(0, 2), beforeRegeneration.extra.cmi_inline_scenes.slots[0].media, 'Previous slot metadata is retained');
        assert.deepEqual(slots[0].media.slice(2).map(item => item.url), slots[0].images, 'Only the new batch is displayed at this location');
        assert.deepEqual(slots[1], beforeRegeneration.extra.cmi_inline_scenes.slots[1], 'Regenerate must leave the other location unchanged');
        assert.equal(await floor.locator('.cmi-inline-scene img').count(), 4, 'Regenerate replaces the selected inline batch instead of appending duplicate images');
        savedChats += (await page.evaluate(() => window.__cmiSmoke.savedChats)) - chatsBeforePlan;
        assert.equal(savedChats, 10, 'Four analyses and six image jobs each request one chat save');
        assert.equal(uploads.length, 12);
        assert.equal(persisted.swipes[0], persisted.mes);
        assert.deepEqual(persisted.swipe_info[0].extra.cmi_inline_scenes, persisted.extra.cmi_inline_scenes);
        assert.deepEqual(persisted.swipe_info[1], inlineMessage.swipe_info[1], 'Other swipe metadata is untouched');
        await page.setViewportSize({ width: 390, height: 844 });
        await floor.screenshot({ path: path.join(outputDir, `ui-inline-scenes-mobile-${layout}.png`) });
        assert.equal(await floor.locator('.cmi-inline-scene').first().evaluate(el => el.scrollWidth <= el.clientWidth + 1), true);
        await page.setViewportSize({ width: 1440, height: 1080 });

        // Legacy versions duplicated inline images in ST's bottom gallery. Read
        // real rendering after its asynchronous media attachment has settled.
        const passiveBefore = { saves: await page.evaluate(() => window.__cmiSmoke.savedChats),
            prompts: await page.evaluate(() => window.__cmiSmoke.promptRequests.length),
            novel: novelCalls.length, manual: manualLlmCalls.filter(call => call.method === 'POST').length };
        const legacy = structuredClone(persisted);
        const legacyExpectedSlots = structuredClone(slots);
        const legacyUrl = url => url.replace('/__cmi_fixture__/', '/__cmi_fixture__/delayed-legacy/');
        for (const slot of legacyExpectedSlots) {
            slot.images = slot.images.map(legacyUrl);
            slot.media = slot.media.map(item => ({ ...item, url: legacyUrl(item.url) }));
        }
        legacy.extra.cmi_inline_scenes.slots = structuredClone(legacyExpectedSlots);
        legacy.extra.media = legacy.extra.cmi_inline_scenes.slots.flatMap(slot => {
            const tagged = slot.media.map(item => ({ ...item, cmi_scene_id: slot.id }));
            delete slot.media; return tagged;
        });
        legacy.extra.media_index = 0;
        const settleMedia = async () => {
            await page.waitForLoadState('networkidle');
            await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        };
        const assertMigratedSlots = async () => {
            const message = await page.evaluate(() => structuredClone(SillyTavern.getContext().chat[0]));
            for (let i = 0; i < legacyExpectedSlots.length; i++) {
                const slot = legacyExpectedSlots[i];
                assert.deepEqual(message.extra.cmi_inline_scenes.slots[i].images, slot.images);
                assert.deepEqual(message.extra.cmi_inline_scenes.slots[i].media,
                    slot.media.map(item => ({ ...item, cmi_scene_id: slot.id })));
            }
            assert.deepEqual(message.swipe_info[0].extra, message.extra, 'Migration syncs only the active swipe');
            assert.deepEqual(message.swipe_info[1], inlineMessage.swipe_info[1]);
            return message;
        };
        await renderFixture(legacy); await settleMedia();
        assert.ok(delayedFixtureImages > 0, 'Legacy fixtures must exercise delayed native-gallery image loading');
        await assertNoBottomImages(); await assertMigratedSlots();
        assert.equal(await page.evaluate(() => SillyTavern.getContext().chat[0].extra.media_index), undefined);
        assert.equal(await floor.locator('.cmi-inline-scene img').count(), 4);
        const unrelated = [
            { url: '/user/images/__cmi_fixture__/other-attachment.png', type: 'image', source: 'upload', title: 'Keep uploaded attachment' },
            { url: '/user/images/__cmi_fixture__/unmatched-scene.png', type: 'image', source: 'generated', title: 'Keep unowned scene', cmi_scene_id: 'other-scene' },
        ];
        const mixed = structuredClone(legacy);
        mixed.extra.media.splice(1, 0, unrelated[0]); mixed.extra.media.push(unrelated[1]);
        mixed.extra.media_index = mixed.extra.media.length - 1; mixed.extra.media_display = 'list';
        mixed.extra.files = [{ name: 'keep-attachment.txt', url: '/user/files/__cmi_fixture__/keep-attachment.txt', size: 4 }];
        await renderFixture(mixed); await settleMedia();
        const migratedMixed = await assertMigratedSlots();
        assert.deepEqual(migratedMixed.extra.media, unrelated, 'Only active cmi_scene_id duplicates are removed');
        assert.equal(migratedMixed.extra.media_index, 1, 'The selected unrelated attachment stays selected');
        assert.deepEqual(migratedMixed.extra.files, mixed.extra.files, 'Non-image attachments are preserved');
        const assertUnrelatedGallery = async () => {
            assert.deepEqual(await floor.locator('.mes_media_wrapper img').evaluateAll(images => images.map(image => image.getAttribute('src'))),
                unrelated.map(item => item.url), 'The bottom gallery contains only the unrelated attachments');
            assert.equal(await floor.locator('.mes_file_wrapper .mes_file_name').textContent(), 'keep-attachment.txt');
            await assertNoLegacyWand();
        };
        await assertUnrelatedGallery();
        await page.evaluate(() => { const context = SillyTavern.getContext(); context.eventSource.emit(context.event_types.CHAT_CHANGED); });
        await settleMedia();
        assert.deepEqual(await assertMigratedSlots(), migratedMixed, 'Repeated rendering must not duplicate migrated slot metadata');
        await assertUnrelatedGallery();
        persisted = JSON.parse(JSON.stringify(migratedMixed));

        // Native swipe replacement and disabled-extension rendering are passive.
        await page.evaluate(() => {
            const context = SillyTavern.getContext(), message = context.chat[0];
            message.swipe_id = 1; message.mes = message.swipes[1]; message.extra = structuredClone(message.swipe_info[1].extra);
            context.updateMessageBlock(0, message); context.eventSource.emit(context.event_types.MESSAGE_SWIPED, 0);
        });
        await page.waitForFunction(() => !document.querySelector('#chat .cmi-inline-generate'));
        await assertNoBottomImages();
        assert.deepEqual(await page.evaluate(() => SillyTavern.getContext().chat[0].extra), inlineMessage.swipe_info[1].extra);
        // Switch back using ST's saved swipe text/metadata, not a regenerated plan.
        await page.evaluate(() => {
            const context = SillyTavern.getContext(), message = context.chat[0];
            message.swipe_id = 0; message.mes = message.swipes[0]; message.extra = structuredClone(message.swipe_info[0].extra);
            context.updateMessageBlock(0, message); context.eventSource.emit(context.event_types.MESSAGE_SWIPED, 0);
        });
        await page.waitForFunction(() => document.querySelectorAll('#chat .cmi-inline-generate').length === 2);
        await settleMedia(); await assertUnrelatedGallery();
        assert.deepEqual(await page.evaluate(() => SillyTavern.getContext().chat[0].extra), persisted.extra);
        await page.evaluate(() => {
            const context = SillyTavern.getContext(); context.extensionSettings.sillytavern_custom_text2img.enabled = false;
            context.eventSource.emit(context.event_types.CHAT_CHANGED);
        });
        await page.waitForFunction(() => !document.querySelector('#chat .cmi-inline-generate'));
        assert.equal(await floor.locator('.mes_text').textContent().then(text => text.includes('[[cmi-image:')), true);
        await page.evaluate(() => { const context = SillyTavern.getContext(); context.extensionSettings.sillytavern_custom_text2img.enabled = true; context.eventSource.emit(context.event_types.CHAT_CHANGED); });
        await page.waitForFunction(() => document.querySelectorAll('#chat .cmi-inline-generate').length === 2);
        assert.equal(await page.evaluate(() => window.__cmiSmoke.savedChats), passiveBefore.saves, 'Migration, swipes and rendering do not save chats');
        assert.equal(await page.evaluate(() => window.__cmiSmoke.promptRequests.length), passiveBefore.prompts, 'Passive rendering never recalls the LLM');
        // Reload modules and restore serialized migrated fixtures, never a real user chat.
        await page.reload({ waitUntil: 'domcontentloaded' }); await page.locator('#cmi_settings').waitFor({ state: 'attached' });
        await fixtureChat(); await renderFixture(persisted);
        await page.waitForFunction(() => document.querySelectorAll('#chat .cmi-inline-scene img').length === 4);
        await settleMedia(); await assertUnrelatedGallery(); await assertMigratedSlots();
        assert.equal(panelSubmissions.length, 4, 'Migration, swiping, disabling, enabling and reload never submit images');
        assert.equal(uploads.length, 12); assert.equal(novelCalls.length, passiveBefore.novel);
        assert.equal(manualLlmCalls.filter(call => call.method === 'POST').length, passiveBefore.manual);
        assert.equal(await page.evaluate(() => window.__cmiSmoke.promptRequests.length), 0, 'Reload never calls the LLM');
        assert.equal(await page.evaluate(() => window.__cmiSmoke.savedChats), 0, 'Reload never saves a chat');
        const manifest = await page.evaluate(async prefix => (await fetch(prefix + 'manifest.json')).json(), extensionPrefix);
        assert.equal(manifest.version, require('../package.json').version);
        const entry = new URL(extensionPrefix + manifest.js, url.origin);
        const requiredAssets = [extensionPrefix + 'manifest.json', extensionPrefix + manifest.css,
            ...RUNTIME_FILES.filter(file => file.endsWith('.js') || file === 'settings.html').map(file => new URL(file, entry).pathname)];
        for (const asset of requiredAssets) assert.equal(assetResponses.get(asset), 200, `Browser must load ${asset}`);
        assert.deepEqual(backendRequests, []); assert.deepEqual(unexpectedWrites, []); assert.deepEqual(fixtureErrors, []);
        assert.deepEqual(pageErrors, []); assert.deepEqual(initializationErrors, []);
        console.log(JSON.stringify({ ok: true, url: url.origin, layout, backend: 'all /api/plugins requests blocked; none made',
            fixtureImageUploads: uploads.length, savedChats, screenshots: outputDir,
            inlineScenes: ['analysis JSON only', 'trusted inline clicks', 'no legacy wand', 'no duplicate bottom gallery',
                'per-slot media metadata/history', 'single-slot regeneration', 'legacy-only and mixed-attachment migration',
                'idempotent rendering', 'native swipe restoration', 'disabled rendering', 'reload restoration'],
            manualLlm: ['OpenAI-compatible endpoint', 'custom model', 'Bearer API key', 'connection test', 'JSON scene planning'],
            novelai: ['JSON', 'ZIP', 'batch', 'encrypted vault', 'reload locks', 'read-only token test'],
            panel: ['direct browser API wiring (fixture)', 'short-lived bearer', 'presets/LoRA/overrides', '64-bit seed', 'retry reads only'],
            panelPreflights: panelCalls.filter(call => call.method === 'OPTIONS').length, panelSubmissions: panelSubmissions.length,
            requiredAssets, blockedSettingsWrites, blockedStartupWrites, delayedFixtureImages, pageErrors, initializationErrors }, null, 2));
    } finally {
        if (browser) await browser.close();
        panel.closeAllConnections(); manualLlmServer.closeAllConnections();
        await Promise.all([
            new Promise(resolve => panel.close(resolve)),
            new Promise(resolve => manualLlmServer.close(resolve)),
        ]);
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
