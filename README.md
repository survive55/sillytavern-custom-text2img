# SillyTavern Custom Text2Img

在 SillyTavern 聊天樓層生成插圖，支援 **ComfyUI／Modal 控制面板**與 **NovelAI 官方圖片 API**。

**v3 是完整的網頁擴展：兩種模式都不需要另外安裝 ST 後端插件、不需要 npm、不需要修改 `config.yaml` 或重啟 ST。**

- 圖片提示詞可使用獨立的 Connection Manager 設定檔，或手動配置 OpenAI 相容 API（Base URL、端點路徑、模型、API Key、驗證 Header、額外 Headers），不切換主聊天連線。
- 全面使用正文標籤插圖：先分析正文，再點各場景按鈕生圖；保留提示詞審閱、前文／角色模板、負向提示詞、圖片參數、批次與 Seed，不再追加底部圖集。
- NovelAI 由瀏覽器直接呼叫官方 API；ComfyUI／Modal 由瀏覽器直連現有控制面板的安全 API。

## 網頁安裝

需要 **SillyTavern >= 1.14.0** 與新版瀏覽器。只有選擇「Connection Manager 設定檔」作為提示詞 LLM 時才需要啟用內建 Connection Manager；手動 OpenAI 相容模式不需要它。

v3.0.2 起支援 1.14.0；不需要升級到 1.18.0。目前支援範圍仍為 **1.14.0 以上，不支援 1.13.x 或更舊版本**；新圖片使用正文標籤顯示，舊版圖集資料仍可相容讀取。從新版匯入、但目前 ST 不認識的連線供應商設定檔會略過，不會阻止本擴展的設定面板載入。

1. 開啟 ST「擴展 → 安裝擴展」，貼上：

   ```text
   https://github.com/survive55/sillytavern-custom-text2img
   ```

2. 重新整理網頁。在 **SillyTavern Custom Text2Img** 設定中選擇生圖來源、填寫連線資訊。
3. 在「提示詞生成」選擇其中一種：
   - **Connection Manager 設定檔**：啟用 ST 內建 Connection Manager，建立專門產生圖片提示詞的設定檔並選取它。
   - **手動 OpenAI 相容 API**：填入 Base URL、自訂 Chat Completions 路徑、模型與 API Key；需要時可改 API Key Header／前綴及額外 Headers。
4. 點擊聊天樓層「⋯」中的多圖圖示「分析正文／插入生圖按鈕」，再逐一點擊正文標籤按鈕。圖片只顯示在各標籤位置，不另加底圖。

不需要開啟 `enableServerPlugins`、`enableCorsProxy` 或 `allowKeysExposure`。
GitHub 安裝下載的檔案已包含完整瀏覽器程式，不需要安裝後執行建置或從 CDN 下載程式。

## 提示詞生成 LLM

提示詞生成與主聊天連線完全獨立，可選：

- **Connection Manager 設定檔**：沿用 ST 的 Chat Completion／Text Completion 設定檔、模型、預設與 instruct。
- **手動 OpenAI 相容 API**：瀏覽器直接呼叫 Chat Completions 格式，可設定 Base URL、相對端點路徑（預設 `chat/completions`）、模型、API Key Header、API Key 前綴與額外 JSON Headers。請求包含 `model`、`messages`、`max_tokens`、`stream: false`，讀取 `choices[0].message.content`。

例如 OpenAI 可填 Base URL `https://api.openai.com/v1`、端點 `chat/completions`、Header `Authorization`、前綴 `Bearer`。其他相容服務可依文件改成 `api-key`、空前綴或加入 `HTTP-Referer` 等 Headers。非本機 Base URL 強制使用 HTTPS，請求不攜帶 ST Cookie、CSRF Token 或瀏覽器憑證；服務本身仍須允許瀏覽器 CORS（包含 `Authorization`／自訂 Header 的 OPTIONS 預檢）。若 ST 是遠端 HTTPS 網站，而 LLM 是使用者裝置上的 HTTP localhost／私有網路服務，瀏覽器仍可能因 Mixed Content 或 Private Network Access 政策阻擋；建議讓 LLM 提供 HTTPS，或從同一台裝置的 localhost ST 使用。

**手動模式的 API Key 會以明文保存在目前 ST 使用者的擴充設定，可能包含在設定匯出、備份或除錯資料中。** 請不要公開設定檔，並只在可信的 ST 網站及擴充環境使用。介面的「測試 LLM」會送出一個極短的實際 Chat Completions 請求，可能產生少量費用。

## 生圖提示詞 LLM 預設

在「提示詞生成 → LLM 提示詞來源」選擇 **匯入的 Chat Completion LLM 預設**，再按「匯入並選用 JSON」。支援 ST 的 `prompts`／`prompt_order`、Prompt Manager 匯出及舊版 `main_prompt` 等欄位；實際按段落啟用狀態、順序、角色、quiet 觸發與 In-Chat 深度組装 LLM 訊息，而不只是套用溫度。**預設 `prompts` 中 `role: user` 一般提示詞項目在巨集展開前略過（`chatHistory`／`dialogueExamples` 容器除外，其內部訊息保留實際角色）（含 In-Chat），不送給 LLM；獨立面板手動輸入與角色對話範例不受此篩選影響。**

匯入只保存於本插件；不切換 ST 主預設、不使用匯入 JSON 的 API 網址／模型／金鑰。可搭配獨立 Chat Completion profile 或手動 API，生成文字再交給圖片來源。**ComfyUI 圖片參數預設是另一個保留相容的選項，不是這裡的 LLM 預設。**

升級預設仍使用原 System／User 模板，舊模板、Text Completion／Instruct 連線與所有圖片設定不會被取代。多組角色順序可指定 `character_id`。

- **正文來源**：模板與匯入預設都只讀被點選樓層及之前的 **assistant `mes`**，不读主聊天 user 樓層、`extra.reasoning` 或畫面 HTML。前文數量只計 assistant 正文；獨立面板的新 user 對話仍會正常傳送。額外正文清理預設為 `[]`（關閉），可自行編輯 JSON 正則，或載入多段 thinking／think 清理範例；不寫死正文包裹方式。
- **獨立正則／變數**：保存並執行原生 `extensions.regex_scripts`，尊重 disabled、來源、深度及 prompt/display 用途；不混用 SPreset、不載入主聊天或全域正則。`setvar`／`getvar` 等巨集使用本次獨立對話變數，不讀寫 ST 聊天變數。旧版匯入已丟棄正則，需重新匯入原始 JSON。
- **舊版互動面板**：全面正文標籤模式不再提供獨立提示詞對話／HTML 互動面板入口，也不執行其腳本；既有匯入預設與設定保留。LLM 只回傳資料型 JSON 場景計畫，圖片提示詞可在各標籤生圖前審閱。

詳見 [LLM 預設格式、套用規則及相容性限制](docs/llm-presets.md)。

## 正文多插圖（手動觸發）

已移除原魔杖「整則生成插圖」入口，統一使用樓層「⋯」內的 **多圖圖示：分析正文／插入生圖按鈕**。

1. 選好「生圖提示詞 LLM 預設」或原有模板與獨立 LLM 連線。
2. 點 **分析正文／插入生圖按鈕**。只呼叫 LLM，讀取此 assistant 正文及已設定前文，規劃多個場景、獨立提示詞與插入位置；**此時不呼叫圖片來源**，也不需要解鎖 NovelAI。
3. 正文出現 **生成插圖：場景名稱** 按鈕。逐一點擊才向目前圖片來源提交該場景；每次沿用目前生圖參數與批次數，開啟提示詞審閱時仍先確認。不再重複呼叫提示詞 LLM。
4. 圖片檔存入 ST，**只在對應標籤位置顯示，不再另加底部圖片／圖集**。**重新生成**只替換該位置的顯示結果；歷次圖片 URL、提示詞與 Seed 仍保存在該場景的 `slot.media`，不刪除圖片檔。舊版帶 `cmi_scene_id`、可對應目前標籤的圖集項目會移到場景歷史，不影響其他附件；此遷移只更新記憶體及目前 swipe，下次正常保存聊天時一併持久化，不會自動呼叫生圖或保存 API。

「提示詞生成 → 正文多插圖」可設定最多 **1–6 個位置（預設 3）**，以及專用分析回應 token 上限（預設 **2400**，只在這項分析取代 LLM 預設的回應上限）。短正文可產生較少位置。

- LLM 回傳資料型 JSON（`scenes[].after / label / prompt`），插件驗證唯一段落／行尾定位後，才插入 `[[cmi-image:ID]]`。**不讓 LLM 改寫原文，也不將回覆當成 HTML／JS 執行。** 位置不吻合、回覆不是 JSON 或數量超限時整次拒絕，不自動重試。不在程式碼區塊插入按鈕。
- 沿用所選預設的順序、樣式、角色、隔離巨集及 raw／prompt 正則；最後附加規劃格式指令與同樣經過過濾的目標正文。此操作不開啟預設 HTML 互動面板。若預設強制非 JSON 回覆或其輸出正則破壞 JSON，會提示失敗；請使用能輸出 JSON 的預設。
- 標籤／提示詞／圖片位置保存在目前訊息的 `extra.cmi_inline_scenes`，並同步目前 swipe。已插入的標籤不再傳給本插件的提示詞 LLM。重整、切換聊天、切換 swipe、訊息重繪只恢復顯示，**不呼叫 LLM 或自動生圖**。
- 同樓層一次只執行一個任務；可點進度通知停止等待。分析／生成期間正文、聊天或 swipe 改變時，不將結果套到其他樓層。已有標籤時不覆蓋既有計畫；要重新分析，可先編輯正文刪除該則的所有 `[[cmi-image:...]]` 標籤（不刪圖片檔；舊場景元資料會在重新分析時被新計畫取代）。
- 依賴原生文字渲染；若其他擴展使用 `extra.display_text` 取代正文，會拒絕分析。顯示正則若隱藏或改寫標籤，需自行讓標籤保留。正文清理後的定位仍須能精確對回原文，否則安全停止。
- 保存使用官方 `getContext().saveChat()`，不繞過 ST 完整性保護。此 API 部分版本會吞掉保存失敗，故完成提示只表示已請求 ST 保存，**不是磁碟持久化查驗**。若 ST 提示保存失敗，勿重整或重新生圖；先恢復連線並保存聊天。圖片／標籤含私人場景，會隨聊天備份匯出。

實作依照 [ST UI Extensions 的 Context／聊天與事件 API](https://docs.sillytavern.app/for-contributors/writing-extensions/)；無需伺服器重啟。

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

## 生成／運行日誌

在 **擴展 → SillyTavern Custom Text2Img → 生成／運行日誌** 展開面板，不必開啟開發者工具。

- 即時記錄初始化、連線測試、面板預設讀取，以及每次生成的 LLM、審閱、提交、任務 ID、進度、下載、保存與完成／停止等階段。每筆有時間、等級、操作 ID、來源、樓層與從操作開始計算的耗時；不同樓層任務可分開篩選。
- 可依任務及等級篩選，**複製／下載目前篩選結果**，或清除全部紀錄。取消「自動捲到底」可回看前面的內容；清除不會停止正在執行的任務。
- 日誌只在目前分頁記憶體保留，最多 **500 筆、約 1 Mi 字元**，超限淘汰最舊紀錄；單筆約 16,000 字元上限，超長內容會截斷。**重整／關閉後清空**，不存入 ST 設定、聊天或瀏覽器本機儲存。
- **錯誤一律直接記錄具體原因、HTTP 狀態（若有）、錯誤類型／代碼與堆疊（若有）**，不需先開詳細模式，也不再另寫一筆 DEBUG 原始錯誤。需要查看 LLM 訊息／原始文字回覆、生圖提示詞／參數與供應商事件時，再手動開啟 **詳細模式**，只記錄之後的內容，不補回先前資料；每次重整預設關閉。Connection Manager 紀錄的是本擴充傳給它的訊息，不是 ST 供應商最終 HTTP 請求。
- API Key、Token、密碼、驗證 Headers／憑證欄位會遮蔽，圖片二進位／base64 不寫入日誌。**上游錯誤即使在一般模式也可能回顯角色或私人聊天**，詳細模式亦會記錄私人內容；**匯出分享前務必檢查**。關閉詳細模式不刪除已記錄內容，需按「清除」移除。敏感資料最小化參考 [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)。

這是本擴充可觀察到的流程紀錄，**不是 ComfyUI／Modal 伺服器的完整終端 stdout/stderr**。ComfyUI 進度依面板回傳事件顯示；NovelAI 官方 API 不提供逐步取樣進度。停止等待後不再輪詢該任務，並不代表後端任務被取消；不要為取得詳細日誌而直接重複提交可能付費的生圖。

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

UI 測試封鎖所有 ST 伺服器插件 API 及真實生圖請求，測試 NovelAI JSON／ZIP、多圖、Token 加密／重新載入鎖定、面板直連／預設／LoRA／輪詢重試與原生樓層圖集，以及日誌預設隱私、詳細模式、篩選、複製／下載／清除、重整清空和手機排版。圖片上傳與聊天／設定保存均使用測試替身，不修改真實資料。原生 CORS 另由面板的 `tests/smoke_browser_api.py` 在**完全不攔截請求**的瀏覽器驗證，使用真實面板 handler 和假 GPU，不呼叫付費服務。

開發時也可從任意 clone 同步前端（會備份並替換部署副本；不需要後端）：

```bash
node scripts/install-ui.cjs --sillytavern /path/to/SillyTavern --user default-user
```

自訂資料目錄加 `--data-root /path/to/data`；遷移舊 `st-comfy-modal-illustrator` 前端加 `--migrate`。

[問題回報](https://github.com/survive55/sillytavern-custom-text2img/issues) · [Apache-2.0 授權](LICENSE)
