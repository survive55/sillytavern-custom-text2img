# v3 瀏覽器版驗證紀錄

## 成功標準

- 使用原版 ST 的 GitHub 網頁擴展安裝結構，不需要 ST 伺服器插件、CORS proxy 或金鑰曝光設定。
- 保留兩個來源的圖片參數、提示詞設定檔、預設／LoRA、批次、Seed 與樓層圖集。
- NovelAI 採瀏覽器直連；依使用者確認，改用加密保存／分頁解鎖，並明確告知重整或關閉頁面可能遺失未完成結果。
- ComfyUI／Modal 使用既有面板的新直連 API；保留背景任務、使用者隔離及工作流行為。

## 驗證結果

| 驗證 | 結果 |
|---|---|
| 擴展 `npm run check` | JavaScript／JSON／manifest／舊相容入口檢查通過 |
| 擴展 `npm test` | **87 tests passed**，包含新增直連／加密測試及舊功能回歸 |
| 面板 `pytest tests/ -q` | **257 passed**；只有既有 Starlette/httpx deprecation warning |
| GitHub 倉庫版 UI（`--layout=repository`） | 真實 ST 1.18 UI，三次測試生成共六張圖，所有 ST plugin API 均封鎖且沒有被呼叫 |
| 獨立前端版 UI（`--layout=standalone`） | 相同流程通過；沒有 JS／初始化錯誤 |
| 面板原生瀏覽器測試 | **不使用任何請求攔截**；11 次原生 CORS 預檢、22 次面板請求；真實面板 handler、假 GPU、兩張圖片；使用者隔離通過，未傳送環境 Cookie／ST CSRF Token |
| 官方 NovelAI CORS | 無憑證 OPTIONS 探測：生成 POST、唯讀帳戶 GET 均允許 `Authorization, Content-Type`，回覆 `Access-Control-Allow-Origin: *`；無效測試 Token 在帳戶 API 回覆 401 |
| Patch whitespace | `git diff --check` 通過 |

## 覆蓋內容

- 與舊後端的 NovelAI request builder 比對所有既有模型／取樣器／噪聲排程及顯式參數，包含 CFG=0、CFG Rescale、Seed=0、1–4 張批次與像素限制。
- 官方 JSON 與 ZIP 多圖片解碼、PNG 檔頭／ZIP CRC 檢查、壓縮與解壓大小上限、非法／空白／過量回應。
- Token 隨機 salt／IV、AES-GCM 完整性驗證、錯誤密語、資料篡改、KDF 參數上限、不安全 context 不退回明文保存。
- v3.0.1 使用官方圖片服務 `GET /user/subscription` 免費、唯讀驗證 Token，不保存帳戶詳情；無效 Token 及只有公開標籤的回應不能被誤認為驗證成功。官方路徑見 [圖片 API 規格](https://image.novelai.net/docs/doc.json)。
- 同分頁／Web Locks 防重、逾時、暫存限制、HTTP／網路／扣點錯誤不重送生圖；停止等待不取消已提交請求。
- 面板 Origin／使用者／密碼版本綁定 Token、Cookie 與 Bearer 分離、狹窄 CORS 路由、禁止預設修改與通用代理。
- 面板預設正負提示詞、LoRA、panel_values、group_states、解析度、批次及 64-bit 字串 Seed。
- 獨立 Connection Manager 請求、提示詞審閱、設定切換後沿用原連線、樓層變更保護與 ST 原生圖集附件。
- 安裝工具在完全沒有 `plugins/` 的 ST 目錄也可同步前端；備份、回復、重複安裝與路徑安全回歸。

## 測試限制

**沒有呼叫付費生圖 API，也沒有喚醒真實 Modal GPU。** 生成回應、提示詞模型和圖片採用測試替身，因此本紀錄不代表某個真實帳號的模型權限、餘額或圖片品質已驗證。

ST UI 測試需要攔截資產與寫入，所以不將它的預檢行為當作原生 CORS 證據；原生 CORS 由面板專用的 `tests/smoke_browser_api.py` 另行驗證。兩種測試都會關閉自己建立的瀏覽器與 loopback fixture，不修改使用者聊天、Token 或連線設定。

本紀錄描述程式驗證，不宣告 GitHub 推送、使用者前端安裝或正式面板服務重載已完成；部署狀態應另行確認。
