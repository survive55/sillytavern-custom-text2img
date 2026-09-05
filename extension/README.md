# SillyTavern Custom Text2Img — 前端

本目錄是 `sillytavern-custom-text2img` 整合專案的前端原始碼，支援 ComfyUI / Modal 與 NovelAI 官方 API。

完整安裝、使用、遷移、安全限制及 API 文件請見專案根目錄的 `README.md`。

請在根專案執行 `npm run install-ui -- --user <handle>` 同步至 SillyTavern。部署副本位於 `data/<handle>/extensions/sillytavern-custom-text2img/`；修改原始碼後須重新同步，不要只修改部署副本。

需要同一版本的 server plugin `plugins/sillytavern-custom-text2img`、`enableServerPlugins: true`、SillyTavern >= 1.18.0 與啟用的 Connection Manager。

NovelAI Token 只能透過設定介面明確儲存到 ST secrets，不寫入本目錄、extensionSettings 或 Git。
