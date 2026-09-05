# SillyTavern Custom Text2Img

在 SillyTavern 聊天樓層生成插圖，支援 **ComfyUI / Modal 控制面板**與 **NovelAI 官方圖片 API**。

- 使用獨立的 Connection Manager 設定檔產生圖片提示詞，不更動主聊天連線。
- 可編輯提示詞、調整圖片參數，生成結果直接加入原樓層圖集。
- 前端與後端放在同一倉庫；**網頁安裝只會安裝前端，生圖仍需要後端插件**。

## 安裝

需要 **SillyTavern >= 1.18.0**、**Node.js >= 20.11**、Git，並能操作 ST 伺服器。
以下終端命令都在 **SillyTavern 根目錄**執行。

### 1. 安裝後端

```bash
git clone https://github.com/survive55/sillytavern-custom-text2img.git plugins/sillytavern-custom-text2img
npm --prefix plugins/sillytavern-custom-text2img ci --ignore-scripts
```

在 ST 的 `config.yaml` 設定 `enableServerPlugins: true`，然後重新啟動 **SillyTavern**。
若插件目錄已存在，請改用下方的更新步驟。

### 2. 安裝前端（二選一）

**網頁安裝：** 開啟「擴展 → 安裝擴展」，貼上：

```text
https://github.com/survive55/sillytavern-custom-text2img
```

**或用終端同步：**

```bash
npm --prefix plugins/sillytavern-custom-text2img run install-ui -- --user default-user
```

將 `default-user` 換成實際使用者 handle。若有舊版 `st-comfy-modal-illustrator`，先用終端方式並加上 `--migrate`；舊前端會備份到 `data/<user>/extension-backups/`。
自訂資料目錄可加 `--data-root /path/to/data`。同一使用者只保留一份前端，不要重複安裝。

完成後重新整理網頁，擴展設定中應出現 **SillyTavern Custom Text2Img**。

## 使用

1. 啟用 ST 內建 **Connection Manager**，建立專門產生提示詞的 API 連線設定檔，並在本插件選取它。
2. 選擇生圖來源：
   - **ComfyUI / Modal**：填入支援任務輪詢的自訂控制面板網址及密碼，測試連線、選取預設。不是原生 ComfyUI 網址；控制面板不包含在本倉庫。
   - **NovelAI**：填入 Persistent API Token 並儲存，選擇模型及圖片參數。
3. 點擊聊天樓層「⋯」中的魔杖按鈕生成插圖。

## 更新

先保存本地修改，再更新後端並重新啟動 SillyTavern：

```bash
git -C plugins/sillytavern-custom-text2img pull --ff-only
npm --prefix plugins/sillytavern-custom-text2img ci --ignore-scripts
```

前端依原安裝方式更新，完成後重新整理網頁：

- **網頁安裝**：在「管理擴展」更新。
- **終端同步**：再次執行上面的 `install-ui` 命令。它會備份並替換部署副本，不要在副本內執行 Git 更新。

ST 的後端自動更新不會同步前端，兩邊都要更新。

## 常見問題

- **`Manifest file not found`**：舊版倉庫缺少根目錄 manifest。請用最新版重新安裝；若提示同名目錄已存在，先備份並移出那份失敗的安裝，再重試。
- **「生圖後端未載入」**：確認已完成後端安裝、安裝依賴、啟用 `enableServerPlugins`，並重啟 SillyTavern。只裝網頁擴展不夠。

## 注意

NovelAI 生圖可能消耗 **Anlas**；中斷等待不代表取消或退款。Token 儲存在 ST 使用者 secrets，請勿公開 Token、密碼或設定檔。ComfyUI 密碼保存在 ST 擴展設定，匯出設定時也要保護它。

開發檢查：在插件倉庫執行 `npm run check` 和 `npm test`，測試不呼叫付費生圖 API。

[問題回報](https://github.com/survive55/sillytavern-custom-text2img/issues) · [Apache-2.0 授權](LICENSE)
