# SillyTavern Custom Text2Img — 瀏覽器擴展 v3

本目錄包含完整的瀏覽器程式，支援 ComfyUI／Modal 與 NovelAI，**不需要 ST 後端插件或修改 ST 設定**。

- 在 ST「安裝擴展」貼上 [專案網址](https://github.com/survive55/sillytavern-custom-text2img)，根目錄 manifest 會載入本目錄。
- 提示詞 LLM 可選 Connection Manager，或直接手動配置 OpenAI 相容 API 的 Base URL、端點路徑、模型、API Key 與 Headers。
- 「LLM 提示詞來源」可匯入 ST Chat Completion JSON，按角色、順序、quiet 與 In-Chat 深度生成提示詞；預設 `prompts` 中 `role: user` 一般提示詞項目略過（`chatHistory`／`dialogueExamples` 容器除外，其內部訊息保留實際角色），不展開巨集、不傳送（含 In-Chat），不影響獨立面板手動輸入與角色对話範例。不切換主預設、不覆蓋 API 連線。支援原生預設 Regex 及本次對話隔離變數；不載入全域／主聊天正則，不混用 SPreset。舊版匯入沒有保存正則，需重新匯入。
- 樓層只讀 assistant 的 `mes` 正文，不讀主聊天 user 樓層、`extra.reasoning` 或畫面 HTML。額外正文清理預設關閉（`[]`），可編輯 JSON 正則或載入 thinking／think 範例；不改寫 ST 原紀錄。獨立預設／正文清理在 Worker 執行，不設時間限制；若正則卡住或處理太久，可按進度提示的「停止」手動終止。
- 正文標籤模式不再開啟舊版獨立提示詞對話／HTML 互動面板；既有預設設定保留，僅使用 JSON 場景規劃。世界書與其他擴展仍不執行。
- 全面使用正文標籤模式，舊魔杖整則生圖入口已移除。樓層「⋯」多圖圖示：手動「分析正文／插入生圖按鈕」。LLM 沿用所選預設／模板，回傳最多 1–6 個場景計畫（預設 3），只插入 `[[cmi-image:ID]]` 而不改寫原文。分析 token 上限預設 2400；插件先驗證安全行尾並提供位置編號，模型回傳 `after_id / label / prompt` JSON，不必抄寫段尾。JSON 不套用正文清理或預設回覆正則，避免有效回覆被清空；輸入正文過濾與預設樣式仍保留。清理前後正文合計上限 20 萬字元／2000 行，無可安全映射位置時在請求前停止。再逐一點正文按鈕才生圖，圖片只顯示在對應標籤，不追加底部圖集。重新生成只更新該位置；歷史 URL、提示詞與 seed 保存在各 slot.media。舊版帶 cmi_scene_id 的重複圖集項目會移到對應場景歷史，不刪圖片檔或其他附件；遷移在下次正常保存聊天時持久化。不自動生圖、不因重繪／重整重送。標籤資料隨訊息與目前 swipe 保存，已存在的計畫不自動覆蓋。
- 正文顯示需保留標籤；`extra.display_text` 樓層拒絕分析，正文清理／正則造成定位無法精確對回原文時安全停止。要重新分析，先編輯正文移除全部舊標籤。原生 `saveChat()` 不保證回報保存失敗；完成表示已請求 ST 保存，若 ST 提示保存錯誤，勿重整或重新生圖，先恢復連線保存聊天。
- ComfyUI 圖片參數預設与 LLM 預設分開保留。
- 「生成／運行日誌」提供即時流程、任務 ID、耗時、進度；錯誤直接顯示具體原因及可取得的 HTTP 狀態、類型／代碼與堆疊，不需開詳細模式。支援依任務／等級篩選、複製、下載與清除。只存於目前分頁（最多 500 筆／約 1 Mi 字元），重整即清空。
- 詳細模式預設關閉，手動開啟後才記錄後續 LLM 訊息／回覆、生圖提示詞／參數；憑證遮蔽、不記錄圖片 base64。上游錯誤與詳細紀錄都可能含私人聊天，分享前請檢查；關閉模式不刪除既有內容，需清除日誌。日誌不是 GPU 伺服器的完整終端輸出；NovelAI 不提供逐步取樣進度。
- 開發者也可執行 `node scripts/install-ui.cjs --sillytavern /path/to/ST --user <handle>` 同步獨立前端。兩種方式二選一，避免重複載入。
- NovelAI 直接呼叫官方 API；Token 可加密保存並以獨立密語解鎖，或僅在目前分頁使用。不讀取 ST 主連線或舊版 secrets。
- ComfyUI／Modal 直接呼叫已更新面板的 `/api/browser` API；仍保留預設、LoRA、覆寫參數、64-bit Seed 和任務輪詢。
- NovelAI 未完成／未保存的結果可能在關閉或重整網頁時遺失；停止等待不代表退款。

## Anima MCP（v3.3，選配）

新增「Anima MCP」設定與生圖來源，搭配 Mcp-image 的 `browser_server.py`（帶 Bearer 驗證與 ST Origin 白名單的 HTTP 入口）。原 stdio 入口不能直接由瀏覽器使用。

- 提示詞工具預設關閉，開啟後只允許勾選的五個 Anima 提示詞工具；生圖仍需點正文按鈕。
- MCP Token 僅存分頁，綁定端點；重整或修改網址後重新貼上並套用。
- 手動 OpenAI 相容 LLM 支援工具循環；CM 需另勾「安全工具傳輸」，只用 profile 路由／模型／Key，不繼承其自訂 body／Headers。原生 Claude／Gemini／Cohere、Text Completion、o1／o3／o4／GPT-5 工具模式暫不支援。其他原功能不變。
- 生圖結果以內嵌圖片回傳，支援完整 64-bit Seed；停止等待不取消 GPU，不自動重送。重整可能遺失尚未保存結果；MCP 主機 output/browser 保留副本。
- 啟動範例（MCP 主機）：先在其私密環境設定 ANIMA_MCP_HTTP_TOKEN，再執行 `venv/bin/python browser_server.py --port 8766 --origin http://127.0.0.1:8001`。手機／遠端需 HTTPS 反向代理與精確來源白名單。

完整設定與限制見專案 `docs/anima-mcp.md`。MCP 獨立 CM 適配目前以 ST 1.18.0 驗證，不宣稱所有舊版均已實測。

需要 SillyTavern >= 1.14.0 與新版瀏覽器；只有使用設定檔模式時才需要啟用 Connection Manager（v3.0.2 起向後相容至 1.14.0；不支援 1.13.x 的舊圖片格式）；Token 加密需 HTTPS／localhost。完整安裝、安全注意及遷移說明見 [專案 README](https://github.com/survive55/sillytavern-custom-text2img#readme)。
