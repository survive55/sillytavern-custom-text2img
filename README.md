# SillyTavern Custom Text2Img

在 SillyTavern 聊天樓層生成插圖，支援 **ComfyUI／Modal 控制面板**與 **NovelAI 官方圖片 API**。

**v3 是完整的網頁擴展：兩種模式都不需要另外安裝 ST 後端插件、不需要 npm、不需要修改 `config.yaml` 或重啟 ST。**

- 使用獨立的 Connection Manager 設定檔生成圖片提示詞，不切換主聊天連線。
- 保留提示詞審閱、前文／角色模板、負向提示詞、圖片參數、批次、Seed 和原樓層圖集。
- NovelAI 由瀏覽器直接呼叫官方 API；ComfyUI／Modal 由瀏覽器直連現有控制面板的安全 API。

## 網頁安裝

需要 **SillyTavern >= 1.18.0** 與新版瀏覽器。

1. 開啟 ST「擴展 → 安裝擴展」，貼上：

   ```text
   https://github.com/survive55/sillytavern-custom-text2img
   ```

2. 重新整理網頁。在 **SillyTavern Custom Text2Img** 設定中選擇生圖來源、填寫連線資訊。
3. 啟用 ST 內建 **Connection Manager**，建立專門產生圖片提示詞的設定檔，在本擴展選取它。
4. 點擊聊天樓層「⋯」中的魔杖按鈕。圖片會加入該樓層的原生圖集。

不需要開啟 `enableServerPlugins`、`enableCorsProxy` 或 `allowKeysExposure`。
GitHub 安裝下載的檔案已包含完整瀏覽器程式，不需要安裝後執行建置或從 CDN 下載程式。

## NovelAI

不需要 ComfyUI、Modal、控制面板網址或 ST 的 NovelAI 主連線設定。

1. 從 NovelAI 帳號設定取得 **Persistent API Token**，貼到本擴展。
2. 選擇保存方式：
   - **加密儲存 Token**：另設至少 12 字元的解鎖密語。只有 AES-256-GCM 加密資料隨目前 ST 使用者設定保存；密語不保存。重整／重新開啟 ST 後，輸入密語並按「解鎖」。
   - **僅本次使用**：Token 只放在目前分頁記憶體，關閉或重整後需重新輸入。
3. 「測試 Token」使用官方圖片服務的唯讀帳戶 API（`GET https://image.novelai.net/user/subscription`）驗證，**不生圖、不消耗 Anlas，也不修改訂閱**；不保存或顯示帳戶詳細資料。測試成功不代表模型權限或餘額足夠。標籤建議 API 可能對無效 Token 也回覆成功，因此不再用它驗證 Token。
4. 選擇模型、取樣器、噪聲排程、Steps、CFG、CFG Rescale、解析度、批次數、Seed 和負向提示詞。

支援原有六種模型（V4.5／V4／V3 及對應變體）、1–4 張批次、JSON 與 ZIP 圖片回應。寬高必須是 64 的倍數；保留每張最多 3145728 像素、每次總計最多 4194304 像素的限制。

### Token 與任務安全

- 加密使用瀏覽器 Web Crypto：PBKDF2-HMAC-SHA-256（600000 次、隨機 salt）及 AES-GCM。需要 **HTTPS 或 localhost**；不會在不支援時退回明文保存。
- 使用**獨立而且足夠強的密語**，不要填 NovelAI 帳號密碼。忘記密語時只能重新貼上 Token，不能從加密資料還原密語。
- 不讀取、不覆蓋 ST 主連線 Token；不需要開啟 ST 金鑰曝光設定。
- 解鎖後，Token 必須在瀏覽器記憶體中供官方 API 請求使用。加密無法防止同頁的惡意擴展、XSS 或被控制的瀏覽器；只使用可信的 ST 網站與擴展。
- 生圖可能消耗 **Anlas**。一次操作只提交一次，失敗不自動重送。停止等待或鎖定 Token **不等於取消生圖或退款**。
- 結果僅在目前分頁記憶體暫存 30 分鐘。**關閉／重整網頁可能遺失未保存的結果**；等待圖片存入聊天後再離開。這與 v2 的 ST 伺服器暫存不同。
- 同分頁限制同時一個 NovelAI 任務；支援 Web Locks 的瀏覽器也會阻擋同來源分頁同時使用同一 Token。不同瀏覽器／不同 ST 網址不共享這個鎖，請勿重複提交。

## ComfyUI／Modal 控制面板

使用你**已存在的自訂控制面板**，不是原生 ComfyUI 網址。本擴展不替你部署 GPU、模型或控制面板。

1. 面板維護者先更新面板，使其提供 [瀏覽器直連 API v1](docs/panel-browser-api.md)（`/api/browser/...`）。這是面板服務的一次更新，**不是安裝 ST 後端插件**。
2. 在本擴展填寫面板的 **HTTPS／Quick Tunnel 網址**及原有 `UI_SHARED_PASSWORD`／`UI_USERS` 密碼。
3. 按「測試連線」，再選取面板預設。

保留原有預設的正負提示詞、`panel_values`、`group_states`、LoRA、解析度及批次；擴展中的參數與進階 JSON 覆寫仍按原規則合併。64-bit Seed 仍以字串傳遞。

瀏覽器以短效、綁定來源與面板使用者的 Bearer Token 呼叫 API，不依賴跨站 Cookie，也不需要開啟全域 CORS 代理。生成仍由面板背景任務執行，短 HTTP 輪詢支援 Quick Tunnel；斷線時只重試讀取，不重新提交 GPU 任務。歷史紀錄及輸出圖片仍由面板依使用者隔離。

**網址必須能從使用 ST 的瀏覽器裝置連到。** `http://127.0.0.1:8800` 只適用於瀏覽器和面板同機；手機／另一台電腦請使用面板 HTTPS 網址。非 loopback 的明文 HTTP 網址會被拒絕，避免傳送明文密碼。

面板密碼仍依舊版方式保存在 ST 擴展設定；匯出設定時不要公開它。短效登入 Token 只保存在目前分頁記憶體。

## 更新與舊版遷移

- **網頁安裝**：在「管理擴展」更新，再重新整理。
- 既有提示詞模板、連線設定檔、面板預設、兩個來源的圖片參數與歷史圖集會保留。
- **v2 的 NovelAI Token 需重新貼上一次**。原版 ST 不允許前端讀取伺服器 secrets，因此不會繞過該限制；舊 Token 檔案及主連線設定不會被刪除或更改。
- ComfyUI／Modal 面板必須先更新到直連 API v1；否則會顯示連線／版本錯誤，不會默默改走舊代理。
- 已裝的舊 ST 後端可以自行停用／移除，但不是 v3 的使用條件。倉庫保留的根目錄 `index.js` 與 `server/` 僅作舊客戶端相容用途，**v3 前端完全不呼叫它們**。
- 同一使用者只保留一份前端。如果以前使用 `install-ui` 部署而非 GitHub 安裝，請先備份／移出那份前端，再用網頁安裝；不要在非 Git 部署副本中執行 Git 更新。

## 開發與離線驗證

以下是**開發者**命令，不是使用者安裝步驟：

```bash
npm ci --ignore-scripts
npm run check
npm test
# 使用既有 ST UI；以測試資產及假 API 驗證，不改使用者的設定／聊天／Token。
npm run test:ui -- http://127.0.0.1:8001 --layout=repository --without-backend
npm run test:ui -- http://127.0.0.1:8001 --layout=standalone --without-backend
```

UI 測試需要已安裝的 Playwright Chromium；也可設定 `CHROMIUM_EXECUTABLE_PATH` 使用既有瀏覽器。

UI 測試封鎖所有 ST 伺服器插件 API 及真實生圖請求，測試 NovelAI JSON／ZIP、多圖、Token 加密／重新載入鎖定、面板直連／預設／LoRA／輪詢重試與原生樓層圖集。圖片上傳與聊天／設定保存均使用測試替身，不修改真實資料。原生 CORS 另由面板的 `tests/smoke_browser_api.py` 在**完全不攔截請求**的瀏覽器驗證，使用真實面板 handler 和假 GPU，不呼叫付費服務。

開發時也可從任意 clone 同步前端（會備份並替換部署副本；不需要後端）：

```bash
node scripts/install-ui.cjs --sillytavern /path/to/SillyTavern --user default-user
```

自訂資料目錄加 `--data-root /path/to/data`；遷移舊 `st-comfy-modal-illustrator` 前端加 `--migrate`。

[問題回報](https://github.com/survive55/sillytavern-custom-text2img/issues) · [Apache-2.0 授權](LICENSE)
