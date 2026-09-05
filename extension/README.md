# SillyTavern Custom Text2Img — 瀏覽器擴展 v3

本目錄包含完整的瀏覽器程式，支援 ComfyUI／Modal 與 NovelAI，**不需要 ST 後端插件或修改 ST 設定**。

- 在 ST「安裝擴展」貼上 [專案網址](https://github.com/survive55/sillytavern-custom-text2img)，根目錄 manifest 會載入本目錄。
- 開發者也可執行 `node scripts/install-ui.cjs --sillytavern /path/to/ST --user <handle>` 同步獨立前端。兩種方式二選一，避免重複載入。
- NovelAI 直接呼叫官方 API；Token 可加密保存並以獨立密語解鎖，或僅在目前分頁使用。不讀取 ST 主連線或舊版 secrets。
- ComfyUI／Modal 直接呼叫已更新面板的 `/api/browser` API；仍保留預設、LoRA、覆寫參數、64-bit Seed 和任務輪詢。
- NovelAI 未完成／未保存的結果可能在關閉或重整網頁時遺失；停止等待不代表退款。

需要 SillyTavern >= 1.14.0、已啟用的 Connection Manager 與新版瀏覽器（v3.0.2 起向後相容至 1.14.0；不支援 1.13.x 的舊圖片格式）；Token 加密需 HTTPS／localhost。完整安裝、安全注意及遷移說明見 [專案 README](https://github.com/survive55/sillytavern-custom-text2img#readme)。
