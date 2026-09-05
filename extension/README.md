# SillyTavern Custom Text2Img — 前端

本目錄是整合專案的前端原始碼，支援 ComfyUI / Modal 與 NovelAI。

- 可在 ST「安裝擴展」貼上 [專案網址](https://github.com/survive55/sillytavern-custom-text2img)，根目錄 manifest 會載入本目錄。
- 或在後端倉庫執行 `npm run install-ui -- --user <handle>`，同步到 `data/<handle>/extensions/sillytavern-custom-text2img/`。
- 兩種方式二選一；生圖都需要另外安裝 `plugins/sillytavern-custom-text2img` 並啟用 `enableServerPlugins`。

需要 SillyTavern >= 1.18.0 與 Connection Manager。完整步驟見 [專案 README](https://github.com/survive55/sillytavern-custom-text2img#readme)。
