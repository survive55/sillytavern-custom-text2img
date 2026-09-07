import { ANIMA_PROMPT_TOOLS, createMcpClient, mcpUrl, buildMcpPayload, mcpText } from './mcp-client.js';

const FIELDS = { url: 'mcpUrl', rounds: 'mcpMaxRounds', api: 'mcpApi', workflow: 'mcpWorkflow', width: 'mcpWidth', height: 'mcpHeight', batch: 'mcpBatchSize', seed: 'mcpSeed', negative: 'mcpNegative', steps: 'mcpSteps', cfg: 'mcpCfg', sampler: 'mcpSampler', scheduler: 'mcpScheduler' };
export function createMcpUi() {
    let token = '', tokenUrl = '';
    function client(settings) {
        const url = mcpUrl(settings.mcpUrl);
        if (!token || tokenUrl !== url) throw new Error('請先在 Anima MCP 設定貼上並套用 Token；變更網址或重整後需重新套用。');
        return createMcpClient({ url, token });
    }
    return {
        client,
        get token() { return token; },
        mount({ getSettings, saveSettings, startLog }) {
            const settings = getSettings();
            const status = (text, error = false) => { const el = document.getElementById('cmi_mcp_status'); el.textContent = text; el.classList.toggle('error', error); };
            for (const [id, key] of Object.entries(FIELDS)) {
                const el = document.getElementById(`cmi_mcp_${id}`);
                el.value = settings[key];
                el.addEventListener('change', () => {
                    settings[key] = id === 'rounds' ? Math.min(10, Math.max(1, Number(el.value) || 6)) : el.value.trim();
                    if (id === 'url') { token = ''; tokenUrl = ''; status('網址已變更；請重新套用 Token。'); }
                    saveSettings();
                });
            }
            for (const [id, key] of [['enabled', 'mcpPromptEnabled'], ['skill', 'mcpReadSkill'], ['profile_transport', 'mcpProfileTransport']]) {
                const el = document.getElementById(`cmi_mcp_${id}`); el.checked = Boolean(settings[key]);
                el.addEventListener('change', () => { settings[key] = el.checked; saveSettings(); });
            }
            const holder = document.getElementById('cmi_mcp_tools');
            for (const name of ANIMA_PROMPT_TOOLS) {
                const label = document.createElement('label'); label.className = 'checkbox_label';
                const input = document.createElement('input'); input.type = 'checkbox'; input.value = name;
                input.checked = settings.mcpPromptTools?.includes(name);
                input.addEventListener('change', () => { settings.mcpPromptTools = [...holder.querySelectorAll('input:checked')].map(el => el.value); saveSettings(); });
                label.append(input, document.createTextNode(name)); holder.append(label);
            }
            document.getElementById('cmi_mcp_apply').addEventListener('click', () => {
                try {
                    const value = document.getElementById('cmi_mcp_token').value.trim();
                    const url = mcpUrl(settings.mcpUrl);
                    createMcpClient({ url, token: value });
                    token = value; tokenUrl = url;
                    document.getElementById('cmi_mcp_token').value = '';
                    status('Token 已套用到目前網址，僅存於本分頁；可按測試連線。');
                } catch (error) { status(error.message, true); }
            });
            document.getElementById('cmi_mcp_lock').addEventListener('click', () => {
                token = ''; tokenUrl = ''; document.getElementById('cmi_mcp_token').value = '';
                status('Token 已清除；已送出的生圖不會因此取消。');
            });
            for (const [id, dryRun] of [['test', false], ['dry_run', true]]) {
                document.getElementById(`cmi_mcp_${id}`).addEventListener('click', async event => {
                    const button = event.currentTarget, log = startLog('anima-mcp');
                    button.disabled = true; status(dryRun ? '預覽參數中（不生圖）…' : '連線與工具清單測試中（不生圖）…');
                    const currentToken = token, currentUrl = settings.mcpUrl;
                    try {
                        const mcp = client(settings), signal = AbortSignal.timeout(30000);
                        const tools = await mcp.listTools(signal);
                        let text;
                        if (dryRun) {
                            const payload = buildMcpPayload('safe, landscape, forest', settings);
                            text = `Dry-run 成功（未呼叫 GPU）：${mcpText(await mcp.callTool('comfyui_generate', { ...payload, dry_run: true }, signal), 4000)}`;
                        } else {
                            const result = await mcp.callTool('comfyui_list_workflows', {}, signal);
                            const data = JSON.parse(mcpText(result));
                            const workflows = Array.isArray(data.workflows) ? data.workflows : [];
                            text = `連線成功；${tools.length} 個工具。工作流：${workflows.map(item => item.name).join('、') || '無'}。未生圖／未喚醒 GPU。`;
                        }
                        if (token === currentToken && settings.mcpUrl === currentUrl) status(text);
                        log.add('mcp.test', dryRun ? 'MCP dry-run 成功（未生圖）' : 'MCP 連線及工作流清單讀取成功（未生圖）');
                    } catch (error) {
                        log.error('mcp.test', error);
                        if (token === currentToken && settings.mcpUrl === currentUrl) status(error.message, true);
                    } finally { button.disabled = false; }
                });
            }
        },
    };
}
