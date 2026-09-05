# ComfyUI／Modal 瀏覽器直連 API v1

本文件供**面板維護者**使用。ST 使用者只需網頁安裝擴展、填入面板 HTTPS 網址與原有密碼；不需安裝任何 ST 伺服器插件。

現有面板的對應實作位於 `ui_server.py` 與 `browser_api.py`。部署時需一併更新兩個檔案，再於沒有生圖任務時重新載入**面板服務**。不需要重新部署 Modal GPU、修改工作流或重新啟動 ST。

## 安全邊界

- 只對 `/api/browser/...` 的明確路由清單開啟 CORS，不對整個面板或原有 Cookie API 開放。
- 請求使用 `credentials: omit`、`redirect: error`；不轉送 ST Cookie、CSRF Token 或其他 ST 憑證。
- 登入回傳一小時有效的 Bearer Token。Token 綁定呼叫端 HTTP(S) `Origin`、面板使用者及密碼版本。更改該使用者密碼或 session secret 會使舊 Token 失效。
- Token 不可作為面板 Cookie；原有 Cookie 亦不可授權瀏覽器 API。請求必須同時有相符 `Origin` 與 `Authorization`。
- 不接受 `null`／`file:` 等 opaque Origin，不把密碼或 Token 放在 URL。HTTPS 仍是必要的傳輸保護；Origin 綁定不代表被偷走的 Bearer Token 在非瀏覽器客戶端不可重用。
- CORS 只允許必要的 GET／POST 和 `Authorization, Content-Type` headers；不設定 `Access-Control-Allow-Credentials`。
- 回應為 `Cache-Control: private, no-store, no-transform`。本機直連的預檢可回覆 `Access-Control-Allow-Private-Network: true`，瀏覽器仍可能要求本機網路權限。
- 不暴露一般 HTTP 代理、任意 URL 抓取、檔案上傳、LoRA 下載或預設寫入／刪除介面。公開部署需使用強密碼，也建議由入口服務限制登入嘗試速率。

## 登入

```http
POST /api/browser/login
Origin: https://your-sillytavern.example
Content-Type: application/json

{"password":"your-existing-panel-password"}
```

成功回傳 JSON，**不設定 Cookie**：

```json
{
  "ok": true,
  "protocol": 1,
  "token": "b1.<signed-claims>.<signature>",
  "expires_at": 1700003600,
  "expires_in": 3600,
  "user": "alice",
  "namespace": "alice",
  "generation_transports": ["poll"]
}
```

`expires_at` 是 Unix 秒，`expires_in` 供瀏覽器避免主機時鐘誤差。Token 只保存在分頁記憶體。面板使用既有密碼判定使用者，不接受客戶端自行宣告任務擁有者。

## 授權請求

以下端點都需要登入 Token 及相同 Origin：

```http
Origin: https://your-sillytavern.example
Authorization: Bearer b1.<signed-claims>.<signature>
```

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/api/browser/queue` | 佇列狀態與 `generation_transports`，不喚醒 GPU |
| GET | `/api/browser/schema` | 既有 schema；只有明確 `?refresh=true` 才刷新模型資訊 |
| GET | `/api/browser/presets` | 目前面板使用者的預設清單 |
| GET | `/api/browser/presets/{name}` | URL 編碼的單一預設，只讀 |
| POST | `/api/browser/generate/jobs` | 提交原有生成 overrides，回傳 202 與任務快照 |
| GET | `/api/browser/generate/jobs/{id}?after=N` | 依游標讀取同一任務的事件 |
| GET | `/api/browser/output/{path}` | 下載自己任務的圖片，回傳原始圖片 bytes |

這些端點直接復用既有面板 handler、工作流編譯、佇列、使用者隔離與歷史紀錄，不建立第二套生圖邏輯。既有 `/api/login` Cookie 登入與 `/api/generate` SSE 等介面仍保留，供原有面板和舊客戶端使用。

## 工作流与輪詢

生成請求直接包含既有欄位，不包一層 `payload`，也不重複帶入密碼：

```json
{
  "prompt_text": "masterpiece, landscape, sunrise",
  "negative_text": "blurry",
  "seed": "18446744073709551613",
  "width": 1216,
  "height": 832,
  "batch_size": 2,
  "panel_values": {},
  "group_states": {"SeedVR2": true},
  "loras": [{"name": "example", "strength": 0.7}],
  "filename_prefix": "sillytavern"
}
```

Seed 必須保留為字串，不能經過 JavaScript Number 捨入。預設合併與進階覆寫仍由擴展依原規則處理。

202 與輪詢回應沿用 `job_id`、`events`、`next_cursor`、`finished`。事件仍包含 `accepted`、`queued`、`warming`、`submitting`、`progress`、`node`、`image`、`done`、`error`。`done.images` 必須列出所有結果，即使早期事件已被裁剪。

面板持有工作任務，HTTP 斷線不會取消 GPU 工作。**提交 POST 絕不自動重試**；讀取可在短暫錯誤後重試相同任務／游標，401 時也可重新登入後再讀一次。不要因為查詢失敗重新提交付費任務。

## 安装範圍

這是對既有外部生圖服務的 API 更新，不是要求每個 ST 使用者另外安裝後端。NovelAI 模式完全不使用此面板；瀏覽器直接存取 `https://image.novelai.net`。

面板網址必須能從瀏覽器所在装置抵達。手機使用遠端 ST 時，`127.0.0.1` 不代表 ST 主機，應使用面板的 HTTPS／Quick Tunnel 網址。
