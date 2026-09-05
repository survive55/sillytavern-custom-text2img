# sillytavern-custom-text2img

整合式 **SillyTavern 樓層插圖插件**：同一專案管理前端擴展和伺服器插件，可在同一設定介面切換 **ComfyUI on Modal 控制面板**與 **NovelAI 官方圖片 API**。

## 功能

- 聊天樓層「⋯」中的魔杖按鈕：讀取該樓層、選定前文及角色描述，生成插圖。
- 使用獨立的 **Connection Manager 連線設定檔**撰寫提示詞，套用該設定檔的 API／模型／預設，不改動主聊天。
- 可自訂系統提示、使用者模板及送出前檢視／編輯提示詞。
- **ComfyUI / Modal**：保留登入、cookie 重登、預設／schema 讀取、LoRA／workflow 覆寫、批次、64-bit 字串 seed、任務進度與圖片下載。預設與 workflow 都不寫回圖片伺服器。
- **NovelAI**：直接使用 `https://image.novelai.net/ai/generate-image`，支援 Anime V4.5 Full/Curated、V4 Full/Curated、Anime V3、Furry V3；可設取樣器、噪聲排程、steps、CFG、CFG rescale、尺寸、批次、seed 與負向提示詞。這是 **text-to-image** 功能，不包含 img2img、inpaint、角色／風格參考或 upscale。
- 兩個來源的圖片參數各自保存。切換來源不會把 ComfyUI 預設、密碼、LoRA 或 64-bit seed 送給 NovelAI。
- 兩個來源均使用「一次提交＋短 HTTP 輪詢」，適用於 Quick Tunnel；生成失敗或斷線**不自動重送付費請求**。
- 圖片儲存於 SillyTavern 的原生圖片目錄，附加到原樓層 `message.extra.media`，支援圖集。生成期間切換聊天、刪除／更動樓層或切換 swipe，不會把圖片附到錯誤訊息。

## 專案結構

```text
sillytavern-custom-text2img/
├── index.js                  # ST server plugin 入口與既有 ComfyUI 路由
├── server/                   # NovelAI API、使用者 secrets、任務與 PNG/ZIP 解碼
├── extension/                # 前端原始碼、manifest、設定 UI、輪詢及測試
├── scripts/install-ui.cjs    # 安裝／同步前端、舊版備份遷移
├── scripts/check.cjs         # JS/JSON、前後端版本與入口檢查
├── package.json
└── package-lock.json
```

ST 原生需要前端與後端放在不同目錄；**這仍是一個專案和一個 Git 倉庫**，不是兩個要分開維護的專案。`extension/` 是前端唯一原始碼來源；安裝目錄是部署副本，勿只修改部署副本。

## 安裝

需要 **Node.js >= 20.11**、**SillyTavern >= 1.18.0**，以及已啟用的內建 `connection-manager` 擴展。

1. 將完整專案放在 `<SillyTavern>/plugins/sillytavern-custom-text2img/`（可由本地 Git clone 或複製）。不要在 ST 的「安裝擴展」對本專案根目錄直接安裝；根目錄是 server plugin。
2. 在本專案目錄執行：

   ```bash
   npm ci --ignore-scripts
   npm run install-ui -- --user default-user
   ```

   已有舊前端 `st-comfy-modal-illustrator` 時，改用：

   ```bash
   npm run install-ui -- --user default-user --migrate
   ```

   - 目標是 `data/<user>/extensions/sillytavern-custom-text2img/`。
   - 安裝器先完整暫存，再替換目標。旧副本及旧前端會備份到 `data/<user>/extension-backups/`，不刪除聊天或設定。
   - 檔案相同時不重複安裝或備份。`--check` 僅比對：同步時 exit 0，不同步時 exit 1，不寫入。
   - 自訂主目錄／資料目錄可加 `--sillytavern /path/to/ST --data-root /path/to/data`；`--user` 必須是已存在的使用者 handle。
   - 不操作全域前端；若 `public/scripts/extensions/third-party/` 有同名或舊版擴展，會停止並提示先手動備份移出，避免雙重載入。
3. 在 ST `config.yaml` 設定 `enableServerPlugins: true`，重新啟動 **SillyTavern**，然後重新整理 ST 網頁。安裝腳本本身不修改設定、不重啟服務。
4. 擴展設定中應出現 **SillyTavern Custom Text2Img**。在「API 連線 → 連線設定檔」建立專門撰寫圖片提示詞的設定檔，再於本插件選擇它。

### 從舊版本遷移

- 原後端 `plugins/comfy-modal-proxy` 已改名為本專案，不應同時保留兩份可載入後端。
- `--migrate` 將舊前端備份移出掃描目錄，避免重複按鈕和事件監聽。
- 首次載入時，舊 `extensionSettings.comfy_modal_illustrator` 的既有欄位會複製到 `sillytavern_custom_text2img`，預設來源仍是 ComfyUI。舊設定保留供回退；已有的新設定不會被覆蓋。
- 路由根改為 `/api/plugins/sillytavern-custom-text2img`。舊 URL 不提供別名，外部客戶端須一起更新。
- 回退時先移出新前端／後端，再將備份還原到舊目錄；不要讓兩個前端並存。

### 更新本地程式碼

```bash
npm ci --ignore-scripts
npm run check
npm test
npm run install-ui -- --user default-user
npm run install-ui -- --user default-user --check
```

後端修改需重新啟動 ST，前端同步後需重新整理 ST。不要將更新副本当成新的 Git 原始碼。純本地 Git 沒有 remote/upstream；若 ST 的 server-plugin 自動更新器提示缺少 upstream，可自行把 `enableServerPluginsAutoUpdate` 設為 `false`。本專案不會設定遠端或推送。

## 使用 ComfyUI / Modal

1. 生圖來源選 **ComfyUI / Modal 控制面板**。
2. 填控制面板的 Base URL 和密碼，按「測試連線」。URL 可為同機的 `http://127.0.0.1:8800` 或 `https://....trycloudflare.com`。
3. 圖片控制面板需提供 `/api/generate/jobs` 和 `/api/generate/jobs/{id}`。不支援時會提示更新 `ui_server.py`，不會偷偷退回 SSE。
4. 讀取預設組合，設定圖片參數、進階覆寫與提示詞連線設定檔，再按樓層魔杖。

Base URL 是 **ComfyUI on Modal 自訂控制面板**，不是原生 ComfyUI 或 SillyTavern 網址。localhost 指 ST 伺服器，不是瀏覽器所在電腦。Quick Tunnel 每次重啟可能更換網址；其 [SSE 限制](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/#limitations) 是採用任務輪詢的原因。

停止等待不會取消已提交的 Modal 工作，仍可從控制面板歷史紀錄取回圖片。ComfyUI 密碼沿用舊版的 ST extension settings 儲存方式；匯出 ST 設定時請注意保護它。代理可連線到管理者使用的本地／遠端控制面板，應只給可信任的 ST 使用者使用。

## 使用 NovelAI

1. 生圖來源選 **NovelAI 官方 API**。
2. 在 NovelAI **User Settings → Account → Get Persistent API Token** 取得 Token。只填 Token，不填帳號密碼、不加 `Bearer `。
3. 在插件輸入並按「儲存 Token」。輸入欄會清空；「已儲存」只表示本地有 Token。
4. 可按「測試 Token（不生圖）」。它只向官方 `/ai/generate-image/suggest-tags` 發出 GET，不會送出生圖或消耗 Anlas；成功不代表所有模型權限、餘額或生成參數都可用。
5. 選擇模型與圖片參數，選擇提示詞連線設定檔，按樓層魔杖。

### 權限、費用與資料

- 使用者每次點擊最多提交一次 NovelAI 生成請求。**可能消耗 Anlas**，不要將預設 1024×1024／28 steps／1 張視為免費保證；收費與模型權限以帳號及官方規則為準。
- 插件的保守限制：尺寸 64–2048 且為 64 的倍數；單張最多 3145728 像素，每次最多 4194304 總像素；1–4 張；1–50 steps；seed 0–4294967295，空白或 -1 為隨機。這些是插件限制，不是方案權利說明。
- 不自動添加品質或負向標籤。V4/V4.5 會建立官方 `v4_prompt`／`v4_negative_prompt`；較舊 V3 不送 V4 欄位。
- Token 以獨立 key `api_key_sillytavern_custom_text2img_novelai` 儲存於 ST **當前使用者的 SecretManager**。不覆蓋主 NovelAI 連線、不放進 extensionSettings、localStorage 或 Git，不向 UI 回傳完整 Token。
- **ST 原生 secrets 檔不是磁碟加密保險箱**，仍須保護主機檔案、備份與 ST 存取權。插件不要求開啟 `allowKeysExposure`，也不改動 CSRF／登入保護。
- Token 只會送到固定官方 HTTPS origin，拒絕重新導向；生成請求不能指定其他 URL。上游錯誤本文可能含敏感資料，因此不原樣轉發或記錄。
- 同一 ST 使用者或同一 Token 同時僅一個進行中的任務。全域最多 16 個保留任務／128 MiB 圖片額度，提交前先保留容量，圖片及回應讀取均有上限。忙碌／滿載時拒絕而不是排入無界佇列。
- 官方 JSON 圖片回應為優先，亦兼容 ZIP；只接受 PNG、只在記憶體解碼，ZIP 檔名不寫入檔案系統。
- 上游期限 5 分鐘；成功／失敗狀態和未儲存圖片在本地記憶體保留 **30 分鐘**，ST 重啟即消失。已透過 ST 儲存的聊天圖片不受此影響。
- 點擊停止等待／關閉網頁不保證取消上游或免扣點。UI 不會自動恢復中斷的任務；若保有提交回傳的 job ID，可在 30 分鐘內用同一使用者的 `/novelai/job` 和 `/novelai/output` 取回。提交回應遺失時請勿立即重複生成。

## 後端 API

根路由：`/api/plugins/sillytavern-custom-text2img`。POST 必須遵守 ST 的登入及 CSRF 規則。所有回應禁止快取。

| 路由 | 用途 |
| --- | --- |
| `GET /probe` | 插件 ID、版本、providers、傳輸能力 |
| `POST /test`、`/presets`、`/preset`、`/schema` | 既有 ComfyUI 連線／唯讀設定；body 包含 `baseUrl`, `password` |
| `POST /jobs`、`/job`、`/output` | 既有 ComfyUI 一次提交／游標輪詢／圖片下載 |
| `POST /generate` | 舊 ComfyUI SSE 相容介面；新 UI 不使用 |
| `POST /novelai/status {}` | 本地 Token 是否存在、支援模型，不回傳 Token |
| `POST /novelai/token {token}` | 儲存本使用者插件專用 Token |
| `POST /novelai/token {clear:true}` | 刪除插件專用 Token，不影響主連線 |
| `POST /novelai/test {}` | 官方標籤 API 的非付費 GET |
| `POST /novelai/jobs {payload}` | 驗證、接受任務，回傳 202 和 `job_id`，只提交一次 |
| `POST /novelai/job {jobId,after:0}` | 回傳 `events`, `next_cursor`, `finished`, `expires_at`；錯誤包含安全訊息與 HTTP 狀態 |
| `POST /novelai/output {path}` | 僅讀取本使用者任務回傳的圖片路徑，回傳 base64、format、mime、bytes、可用時的 seed |

NovelAI payload 範例（不包含金鑰）：

```json
{
  "payload": {
    "prompt": "a watercolor landscape, sunrise",
    "negative_prompt": "blurry",
    "model": "nai-diffusion-4-5-full",
    "width": 1024,
    "height": 1024,
    "steps": 28,
    "scale": 5,
    "cfg_rescale": 0,
    "sampler": "k_euler_ancestral",
    "noise_schedule": "native",
    "n_samples": 1,
    "seed": "0"
  }
}
```

## 驗證

```bash
npm run check
npm test
```

自動測試使用 loopback／注入的模擬服務，不讀真實 Token、不呼叫真實 GPU 或 NovelAI 生圖。涵蓋舊 ComfyUI 路由、401 重登、Tunnel、SSE 相容、輪詢、不重複提交、NovelAI JSON/ZIP 與模型欄位、身份隔離、401/402/403/429 錯誤、參數驗證、超時、容量／清理、設定遷移及安裝器。

可另對已啟動的本地 ST 執行真實 Chromium 介面冒煙測試：

```bash
# 首次使用且沒有 Chromium 時：npx playwright install chromium
npm run test:ui -- http://127.0.0.1:8001
# 或指定已安裝的 Chromium：
CHROMIUM_EXECUTABLE_PATH=/path/to/chrome npm run test:ui -- http://127.0.0.1:8001
```

此測試只接受 loopback 網址，檢查新 UI 載入、來源切換、模型欄位及真實 ST secrets 狀態介接。它攔截設定儲存、Token 寫入及生圖請求，不更改帳號設定或消耗 Anlas；連線測試的錯誤由模擬回應提供。截圖輸出至被 Git 忽略的 `test-results/ui-smoke.png`，瀏覽器在結束時關閉。

真實 NovelAI／Modal 成功出圖仍需使用者有效帳號與額度驗證；離線測試不能證明官方服務此刻可用或特定帳號享有模型權限。

## 參考

- [SillyTavern Server Plugins](https://docs.sillytavern.app/for-contributors/server-plugins/)
- [SillyTavern UI Extensions](https://docs.sillytavern.app/for-contributors/writing-extensions/)
- [NovelAI 官方 Image API 文件](https://image.novelai.net/docs/index.html)／[機器可讀 schema](https://image.novelai.net/docs/doc.json)
- [Persistent API Token 取得方式](https://docs.sillytavern.app/usage/api-connections/novelai/)

本專案預設為私有本地套件（`private: true`, `UNLICENSED`），沒有自行指定遠端或授予開源許可；如需發佈，請由專案擁有者決定授權與發佈位置。
