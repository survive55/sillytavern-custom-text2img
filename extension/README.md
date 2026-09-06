# SillyTavern Custom Text2Img — 瀏覽器擴展 v3

本目錄包含完整的瀏覽器程式，支援 ComfyUI／Modal 與 NovelAI，**不需要 ST 後端插件或修改 ST 設定**。

- 在 ST「安裝擴展」貼上 [專案網址](https://github.com/survive55/sillytavern-custom-text2img)，根目錄 manifest 會載入本目錄。
- 提示詞 LLM 可選 Connection Manager，或直接手動配置 OpenAI 相容 API 的 Base URL、端點路徑、模型、API Key 與 Headers。
- 「LLM 提示詞來源」可匯入 ST Chat Completion JSON，按角色、順序、quiet 與 In-Chat 深度生成提示詞；預設 `prompts` 中 `role: user` 一般提示詞項目略過（`chatHistory`／`dialogueExamples` 容器除外，其內部訊息保留實際角色），不展開巨集、不傳送（含 In-Chat），不影響獨立面板手動輸入與角色对話範例。不切換主預設、不覆蓋 API 連線。支援原生預設 Regex 及本次對話隔離變數；不載入全域／主聊天正則，不混用 SPreset。舊版匯入沒有保存正則，需重新匯入。
- 樓層只讀 assistant 的 `mes` 正文，不讀主聊天 user 樓層、`extra.reasoning` 或畫面 HTML。額外正文清理預設關閉（`[]`），可編輯 JSON 正則或載入 thinking／think 範例；不改寫 ST 原紀錄。
- 預設可啟用獨立提示詞對話面板。HTML 先靜態預覽，嵌入 JS 每次需明確啟用，只支援有限的獨立輸入／送出相容介面；不是完整酒館助手／STscript。iframe 沒有主頁同源權限，JS 需支援 credentialless 的瀏覽器。隔離限制資源載入，但不是完整斷網／CPU 沙箱，只執行可信預設。腳本「直接送出」只提出請求，需在插件面板確認才呼叫提示詞 LLM；圖片生成另行確認。世界書與其他擴展仍不執行。
- 新增樓層「⋯」多圖圖示：手動「分析正文／插入生圖按鈕」。LLM 沿用所選預設／模板，回傳最多 1–6 個場景計畫（預設 3），只插入 `[[cmi-image:ID]]` 而不改寫原文。專用分析 token 上限預設 2400；此操作不開 HTML 互動面板，預設與輸出正則需保留有效 JSON。再逐一點正文按鈕才生圖，圖片顯示在對應段落並保留原生圖集；不自動生圖、不因重繪／重整重送。標籤資料隨訊息與目前 swipe 保存，已存在的計畫不自動覆蓋。
- 正文顯示需保留標籤；`extra.display_text` 樓層拒絕分析，正文清理／正則造成定位無法精確對回原文時安全停止。要重新分析，先編輯正文移除全部舊標籤。原生 `saveChat()` 不保證回報保存失敗；完成表示已請求 ST 保存，若 ST 提示保存錯誤，勿重整或重新生圖，先恢復連線保存聊天。
- ComfyUI 圖片參數預設与 LLM 預設分開保留。
- 「生成／運行日誌」提供即時流程、任務 ID、耗時、進度、錯誤摘要，支援依任務／等級篩選、複製、下載與清除。只存於目前分頁（最多 500 筆／約 1 Mi 字元），重整即清空。
- 詳細模式預設關閉，手動開啟後才記錄後續 LLM 訊息／回覆、生圖提示詞／參數及原始錯誤；憑證遮蔽、不記錄圖片 base64。詳細紀錄可能含私人聊天，分享前請檢查；關閉模式不刪除既有內容，需清除日誌。日誌不是 GPU 伺服器的完整終端輸出；NovelAI 不提供逐步取樣進度。
- 開發者也可執行 `node scripts/install-ui.cjs --sillytavern /path/to/ST --user <handle>` 同步獨立前端。兩種方式二選一，避免重複載入。
- NovelAI 直接呼叫官方 API；Token 可加密保存並以獨立密語解鎖，或僅在目前分頁使用。不讀取 ST 主連線或舊版 secrets。
- ComfyUI／Modal 直接呼叫已更新面板的 `/api/browser` API；仍保留預設、LoRA、覆寫參數、64-bit Seed 和任務輪詢。
- NovelAI 未完成／未保存的結果可能在關閉或重整網頁時遺失；停止等待不代表退款。

需要 SillyTavern >= 1.14.0 與新版瀏覽器；只有使用設定檔模式時才需要啟用 Connection Manager（v3.0.2 起向後相容至 1.14.0；不支援 1.13.x 的舊圖片格式）；Token 加密需 HTTPS／localhost。完整安裝、安全注意及遷移說明見 [專案 README](https://github.com/survive55/sillytavern-custom-text2img#readme)。
