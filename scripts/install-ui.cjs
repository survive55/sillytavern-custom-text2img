'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID = 'sillytavern-custom-text2img';
const LEGACY_ID = 'st-comfy-modal-illustrator';
const RUNTIME_FILES = Object.freeze(['index.js', 'generation.js', 'providers.js', 'http.js', 'manual-llm.js', 'panel.js', 'novelai.js', 'novelai-payload.js', 'images.js', 'token-vault.js', 'settings.html', 'style.css', 'package.json', 'README.md', 'manifest.json']);

function plainDirectory(location) {
    if (!fs.existsSync(location)) return;
    const stat = fs.lstatSync(location);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`拒絕操作非一般目錄或符號連結：${location}`);
}

/** Install only into an existing user. Never edit config.yaml, settings or secrets. */
function installUi({ root = path.resolve(__dirname, '../../..'), user = 'default-user', dataRoot,
    source = path.resolve(__dirname, '../extension'), migrate = false, check = false } = {}) {
    root = path.resolve(root);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(user)) throw new Error('user 必須是單一合法使用者目錄名稱。');
    const host = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (host.name !== 'sillytavern') throw new Error('指定目錄不是 SillyTavern 根目錄。');
    const manifest = JSON.parse(fs.readFileSync(path.join(source, 'manifest.json'), 'utf8'));
    if (manifest.js !== 'index.js' || manifest.css !== 'style.css') throw new Error('來源不是完整的獨立前端目錄。');
    const userRoot = path.join(path.resolve(dataRoot || path.join(root, 'data')), user);
    plainDirectory(userRoot);
    if (!fs.existsSync(userRoot)) throw new Error(`使用者不存在：${userRoot}（自訂 dataRoot 請加 --data-root）`);
    const extensions = path.join(userRoot, 'extensions');
    const backups = path.join(userRoot, 'extension-backups');
    const destination = path.join(extensions, ID);
    const legacy = path.join(extensions, LEGACY_ID);
    for (const location of [extensions, backups, destination, legacy]) plainDirectory(location);
    if (fs.existsSync(destination) && fs.realpathSync(destination) === fs.realpathSync(source)) {
        throw new Error('來源不能與安裝目錄相同。');
    }
    for (const name of [ID, LEGACY_ID]) {
        const globalExtension = path.join(root, 'public/scripts/extensions/third-party', name);
        if (fs.existsSync(globalExtension)) throw new Error(`發現全域擴展 ${globalExtension}；請先手動備份移出，避免雙重載入。`);
    }
    if (fs.existsSync(legacy) && !migrate) throw new Error('發現舊前端；請加 --migrate 將它備份移出 extensions，避免重複按鈕。');
    for (const name of RUNTIME_FILES) {
        const file = path.join(source, name);
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`來源不是一般檔案：${file}`);
    }
    const synchronized = RUNTIME_FILES.every(name => {
        const target = path.join(destination, name);
        return fs.existsSync(target) && fs.lstatSync(target).isFile()
            && fs.readFileSync(target).equals(fs.readFileSync(path.join(source, name)));
    });
    const changed = !synchronized || fs.existsSync(legacy);
    if (check || !changed) return { changed, destination, backups: [] };

    // Stage outside extensions, so the loader cannot see a half-installed UI.
    const stage = fs.mkdtempSync(path.join(userRoot, '.custom-text2img-'));
    const backupRoot = path.join(backups, `${ID}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
    const moved = [];
    let installed = false;
    try {
        for (const name of RUNTIME_FILES) fs.copyFileSync(path.join(source, name), path.join(stage, name));
        fs.mkdirSync(extensions, { recursive: true });
        for (const previous of [destination, legacy]) {
            if (!fs.existsSync(previous)) continue;
            fs.mkdirSync(backupRoot, { recursive: true });
            const backup = path.join(backupRoot, path.basename(previous));
            fs.renameSync(previous, backup);
            moved.push({ previous, backup });
        }
        fs.renameSync(stage, destination);
        installed = true;
        return { changed: true, destination, backups: moved.map(entry => entry.backup) };
    } catch (error) {
        if (!installed) {
            for (const { previous, backup } of moved.reverse()) fs.renameSync(backup, previous);
        }
        throw error;
    } finally {
        if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
    }
}

function parseArgs(args) {
    const options = {};
    const values = { '--sillytavern': 'root', '--data-root': 'dataRoot', '--user': 'user' };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (values[arg]) {
            const value = args[++i];
            if (!value || value.startsWith('--')) throw new Error(`${arg} 缺少參數`);
            options[values[arg]] = value;
        } else if (arg === '--migrate') options.migrate = true;
        else if (arg === '--check') options.check = true;
        else if (arg === '--help') options.help = true;
        else throw new Error(`不認識的參數：${arg}`);
    }
    return options;
}

if (require.main === module) {
    try {
        const options = parseArgs(process.argv.slice(2));
        if (options.help) {
            console.log('node scripts/install-ui.cjs [--sillytavern /path/to/ST] [--data-root /path/to/data] [--user default-user] [--migrate] [--check]');
            console.log('可從任意專案 clone 同步前端；不需要 ST 後端插件。安裝不修改設定或重啟服務；--check 僅比對（不同時 exit 1）。');
        } else {
            const result = installUi(options);
            console.log(JSON.stringify(result, null, 2));
            if (options.check && result.changed) process.exitCode = 1;
        }
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { installUi, parseArgs, RUNTIME_FILES, ID, LEGACY_ID };
