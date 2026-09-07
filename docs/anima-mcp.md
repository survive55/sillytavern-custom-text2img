# Anima ComfyUI MCP（v3.3）

支援 `/home/ubuntu/Mcp-image/anima-comfyui-mcp` 的 **Anima browser profile v1**。
這不是任意 MCP 客戶端：目前不支援 stdio、舊 SSE 入口、OAuth 登入、任意工具或 Responses API。
既有 NovelAI／面板模式不變，MCP 預設關閉；不需要安裝 ST 後端插件。

## 1. 啟動 MCP 的 HTTP 入口

在 MCP 主機的專案目錄執行（不是 ST 目錄）：

```bash
venv/bin/python -m pip install 'mcp>=2.2,<3' 'httpx>=0.27' 'websocket-client>=1.8' 'starlette>=0.37' 'uvicorn>=0.30'
venv/bin/python -c 'import secrets; print(secrets.token_urlsafe(32))'
```

將產生的獨立隨機 Token 以 `ANIMA_MCP_HTTP_TOKEN` 放入 MCP 的私密 `.env` 或服務環境。
不要使用面板密碼、Modal 金鑰或 LLM API Key 當作 MCP Token，也不要提交私密 `.env`。
維持既有 `ANIMA_PANEL_*`／`ANIMA_COMFYUI_*` 生圖設定。

```bash
venv/bin/python browser_server.py --port 8766 --origin http://127.0.0.1:8001
```

- `--origin` 必須是瀏覽器實際開啟的 **ST origin（協定＋主機＋port，不含路徑或尾斜線）**，可重複指定。不是 DSH 的 3080。
- 端點是 `http://127.0.0.1:8766/mcp`；僅綁定 loopback。
- 手機／遠端瀏覽器的 localhost 不是 MCP 主機。請自行配置可信 HTTPS 反向代理，保留 Authorization、Origin 與 MCP headers；加 `--public-host mcp.example.com --origin https://st.example.com`。不可用萬用 Origin 或未驗證公開代理。
- HTTP ST origin 只允許 localhost；遠端必須 HTTPS。瀏覽器的 Mixed Content／Private Network Access 政策仍可能拒絕跨網路存取。
- 這是單一可信擁有者入口，所有知道同一 Token 的人共享該 MCP 主機的生圖能力，**不是 ST 多租戶隔離**。
- 此次功能安裝不會自動寫入真實 Token、修改生圖帳號、啟動正式 MCP 常駐服務或觸發付費生圖。

原來的 `server.py` 與既有 stdio 客戶端仍可使用。HTTP 入口刻意不提供任意 `output_dir`、絕對 workflow 路徑、GPU 模型列舉或任意面板任務讀取。

## 2. ST 設定

更新／同步擴展後重新整理，在擴展設定打開 **Anima MCP：提示詞工具與生圖連線**：

1. 填 HTTP MCP 端點。
2. 貼 MCP 專用 Token，按「套用 Token（僅本分頁）」；Token 不存入設定／聊天／備份。
3. 按「測試連線／列工作流」：只握手、列工具及本機 workflow，不生圖、不查 GPU。
4. 重整或改 MCP 網址後必須重新套用 Token。換網址時不沿用舊憑證。

### 提示詞工具

勾選「分析正文時啟用 Anima 提示詞工具」，選擇允許的工具：

- `anima_search_codex`
- `anima_adapt_prompt`
- `anima_assemble_prompt`
- `anima_validate_prompt`
- `anima_codex_index`

可讀取 `pomelo://SKILL.md` 作為參考。此資料不執行為 HTML、JavaScript 或 STscript。
本次場景／模型選出的查詢可能傳給 MCP，工具回覆與參考資料會傳給獨立 LLM；可能增加 LLM 費用。

**獨立 LLM：**

- 支援非串流 OpenAI Chat Completions 的 `tool_calls` 協議；模型仍須實際支援 function calling。
- 手動 API 使用原有網址、驗證 Headers 與插件匯入的取樣設定。
- Connection Manager 需另外勾選「安全工具傳輸」：只使用 profile 路由、模型及 secret ID，不繼承連線預設的自訂 Headers／body／其他特殊生成設定。本插件匯入的提示詞預設與其取樣参数仍保留。
- CM 首版限 OpenAI／DeepSeek／OpenRouter／Custom。依賴額外 Headers 的服务請用手動 API。
- CM 非空的後處理只接受 `merge_tools`、`semi_tools`、`strict_tools`。工具循環中 profile 改變時停止，不把舊資料傳至新路由。
- 原生 Claude／Gemini／Cohere、Text Completion、legacy `function_call`／Responses API 暫不支援。o1／o3／o4／GPT-5 系列需要專用 token／推理參數映射，這一版工具模式明確拒絕；既有非 MCP 模式不變。
- 獨立工具傳輸驗證基於本機 ST 1.18.0；原功能仍以 1.14 為最低版本，**不宣稱 CM MCP 跨所有舊版已實測**。

輪數 1–10（預設 6）、總呼叫最多 20、同輪最多 4 個且按順序執行，總時間 240 秒。整批參數先驗證，再執行任何一個工具。
未知／生圖工具、畸形或重複 ID、參數錯誤、截斷／空白結果直接停止。不自動重試，不解析文字中的「假工具呼叫」。
工具歷史只留在本次分析，不寫入主聊天；最後仍走既有場景 JSON 校驗及正文定位。

### MCP 生圖

將「生圖來源」選為 **Anima ComfyUI MCP**，設定 API、workflow 名稱、解析度、批次、Seed、取樣參數與負向提示詞。

- Panel 使用 MCP 主機面板的 workflow，workflow 欄位留空；Auto 有面板密碼時走 Panel。
- ComfyUI 直連可填測試列出的 workflow 名稱，不能填伺服器任意路徑。
- 不沿用另一個 ComfyUI 面板來源的預設、LoRA 或任意 JSON 覆寫；此版本 HTTP profile 不提供 LoRA 參數。
- Dry-run 使用固定風景提示詞及目前參數，只離線組裝，不驗證實際 GPU／模型／面板登入，也不收費。
- 分析正文不生圖。只在點擊正文場景按鈕後送出一次 `comfyui_generate`，提示詞審閱仍有效。
- Seed 使用十進位字串，完整保留 64-bit。寬高 64–2048、8 的倍數，批次 1–4，總像素最多 4194304。
- 真實圖片以 MCP image blocks 回傳（PNG／JPEG／WebP），每張最多 8 MiB、總計 32 MiB；下載時及保存前限制數量／bytes。前端不接受任意本機路徑、外部圖片 URL 或 SVG。
- 不提供逐步取樣進度。停止等待不取消 GPU，也不保證退款；原請求仍由目前分頁接收，不重送。
- 分頁結果保留 30 分鐘；重整可能遺失尚未存入 ST 的結果。MCP 主機 `output/browser/<run-id>/` 保留圖片，可手動恢復；檔案不自動清除，主機擁有者需自行管理磁碟。
- 單一 HTTP 程序只允許一個生成／dry-run 同時執行；不要以多 worker 部署後假設仍有全域鎖。

## 驗證

```bash
# 插件目錄：離線單元／回歸
npm run check
npm test
# 本機已啟動的 ST；真實 MCP HTTP+CORS，假 LLM／GPU／圖片保存
ANIMA_MCP_PROJECT=/path/to/anima-comfyui-mcp \
CHROMIUM_EXECUTABLE_PATH=/path/to/chrome \
node scripts/smoke-mcp-ui.cjs http://127.0.0.1:8001

# MCP 目錄：真實 SDK ASGI transport，假生圖；無 GPU
venv/bin/python -m pytest tests/ -q
```

UI 測試會啟動短期 MCP fixture 並在結束時關閉；不重啟 ST 或 DSH，不修改真實聊天、設定或 Token。相容性基於假供應商往返及實際 MCP 協議；不代表已測真實模型／GPU 生成。

協議依據：[MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)、[Python SDK](https://py.sdk.modelcontextprotocol.io/)。
