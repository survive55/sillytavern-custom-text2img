# 生圖提示詞 LLM 預設

「LLM 預設」指 **SillyTavern Chat Completion 的提示詞預設**，不是 ComfyUI workflow／圖片參數預設。它告訴文字模型如何把場景轉成生圖提示詞，輸出再送給 NovelAI 或 ComfyUI。

## 使用方式

1. 在 ST 的 AI 回應設定匯出 Chat Completion 預設 JSON；也可使用 Prompt Manager 匯出的 JSON。
2. 本插件 → 提示詞生成 → LLM 提示詞來源 → **匯入的 Chat Completion LLM 預設**。
3. 按 **匯入並選用 JSON**。最多 20 份，每份最多 2 MiB；同名匯入會另存編號，不覆蓋舊項目。錯誤檔案不改動現有選擇。
4. 如有多個角色順序，可在下拉選擇 `character_id`。預設選 ST 全域順序 `100001`；只有一組時直接選用；沒有全域且有多組時，必須自行選擇，不猜測第一組。
5. 在上方選擇 **Chat Completion Connection Manager 設定檔**或**手動 OpenAI 相容 API**。點樓層魔杖即可依預設呼叫 LLM，將輸出交給圖片服務。建議先勾「檢視 / 編輯提示詞」。

匯入只存到插件自己的擴充設定，**不寫入或切換 ST 主預設，不覆蓋主聊天連線、角色卡與聊天**。匯入内容可能含個人提示詞，會隨 ST 設定備份；請勿隨意公開。

## 支援格式與組裝規則

- 完整 Chat Completion JSON：`prompts`、`prompt_order`。
- Prompt Manager `version: 1` 的 `full`／`character` 匯出：`data.prompts` 與平面 `data.prompt_order`。
- Prompt Manager 之前的舊版欄位：`main_prompt`、`nsfw_prompt`、`jailbreak_prompt`。包含刻意留白的欄位，不偷偷補回 ST 的角色扮演預設。
- 缺少順序時採 ST 內建順序，不依 `prompts` 儲存順序、不自動啟用所有自訂段落；有警告提示。明確的順序以該組為準。
- 以順序項目的 `enabled` 決定啟用，按 `identifier` 對應文字，支援 `system`／`user`／`assistant`。
- 背景提示詞生成採 **quiet**。`injection_trigger` 留空適用所有類型，有值則必須包含 `quiet`。只勾 Normal 的段落不會在此模式送出。
- Relative 按順序排列；In-Chat 按 `injection_depth`、`injection_order` 注入。深度計算原始聊天訊息數，不計已插入的段落。同深度、同 order、同 role 合併換行；角色排列依本機 ST 的反轉歷史演算法為 assistant → user → system。
- `chatHistory` 放入所選前文及目標樓層。沒有列出 marker 的部分匯出會補場景（在 PHI 前）；**明確停用的 marker 不重啟**。停用時可以在段落用 `{{message}}` 自行引用場景。
- 角色描述、個性、場景、Persona、文字對話範例，以及 new-chat／new-example／personality／scenario 格式可用。
- 群聊以被點選作者的原始卡片為來源，不借用目前最後發話者的巨集結果；前文及多角色範例保留姓名。這不是完整群聊卡片 join 策略。
- `{{message}}`、`{{history}}`、`{{description}}` 等插件巨集仍可用。`{{lastMessage}}`、`{{lastMessageId}}`、`{{lastUserMessage}}`、`{{lastCharMessage}}` 限定在被點樓層及其之前；聊天內容裡形似巨集的文字不再展開。其他 ST 巨集仍由 ST 展開，依賴全域／擴展狀態的巨集不保證是樓層快照。

## 生成參數與連線隔離

可攜參數為 `temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、非負整數 `seed`；也接受對應舊欄位 `temp_openai`、`top_p_openai`、`freq_pen_openai`、`pres_pen_openai`。`seed: -1` 不傳固定 seed。`openai_max_tokens` 優先於插件的回應上限；未指定才用插件原設定。

- **手動 API**：只將上述參數加到請求。URL、端點、模型、API Key 與 Headers 永遠由手動連線欄位決定。未提供的參數由 API 預設決定。
- **Connection Manager**：繼續透過 ST 官方 `sendRequest`。保留使用者**既有連線設定檔所引用的可信 CC preset**，因此自訂驗證 Headers、供應商驗證與其他傳輸規則不會因升級消失。匯入的可攜參數用第五個 `overridePayload` 覆蓋；未提供的參數沿用原連線 preset。ST 此路徑不組裝 `prompts`／`prompt_order`，所以不會重複加入提示詞。
- **匯入 JSON** 中的模型、網址、代理密碼、API key、Headers、custom body、工具、腳本與擴展設定均不採用。連線 preset 的既有自訂 body／後處理仍可能改寫最終請求，與舊模板模式一致。

`top_k`、`min_p`、reasoning 等非通用參數及其他無法套用的功能會列出相容性提示；不宣稱跨所有 API 完整重現 ST 一般聊天請求。上方「測試 LLM」仍只是固定短句的連通性測試，不使用生圖預設。

## 邊界與向後相容

- 保持 ST **1.14.0** 最低版本。其 `ConnectionManagerRequestService.sendRequest` 已有第五個覆寫參數；不依賴新版才有的 profile getter。
- 升級仍預設選 **原有 System / User 模板**。既有模板、連線選擇、手動 API 欄位、token 上限、图片參數與歷史圖集不變。
- 原 Text Completion／Instruct 連線在原模板模式照常使用；選 Chat Completion 匯入預設時，不將它猜測轉換為文字補全格式，而是請使用者改用 CC 連線。
- 切回模板不刪除已匯入的預設；刪除所選預設需確認，然後恢復原模板模式。還原模板按鈕不刪除 LLM 預設。
- 不執行世界書掃描、第三方 Regex、JS／STscript、工具與完整角色扮演生成管線；這些欄位不會被當作提示詞文字送出。角色卡的 main/PHI overrides 不覆蓋此獨立生圖預設；`forbid_overrides` 因而不需改動主卡片設定。
- 沒有完整 tokenizer/context-budget 截斷；由附帶樓層數限制聊天量，超過供應商 context 時 API 會報錯，請縮小前文或預設。`openai_max_context` 不會被誤當輸出 token 上限。
- ComfyUI **圖片參數預設**仍按舊規則保留、合併 LoRA／解析度／正負提示詞，與 LLM 預設是不同選項。

## 實作依據

已閱讀而非猜測以下 ST 合約：

- [官方 Prompt Manager 文件](https://docs.sillytavern.app/usage/prompts/prompt-manager/)：排序、角色、quiet、In-Chat、marker。
- `public/scripts/preset-manager.js`：preset 匯入、名稱索引與 `getCompletionPresetByName`。
- `public/scripts/PromptManager.js`：舊欄位遷移、預設順序、版本 1 匯出、`entry.enabled`、trigger。
- `public/scripts/openai.js`：全域 dummy id `100001`、反轉歷史的注入排列、角色／場景 marker。
- `public/scripts/custom-request.js`：`processRequest` 及 `presetToGeneratePayload` 只做 payload 設定，不跑 Prompt Manager。
- `public/scripts/extensions/shared.js` 與 [ST 1.14.0 原始碼](https://github.com/SillyTavern/SillyTavern/blob/1.14.0/public/scripts/extensions/shared.js)：獨立 profile 請求、既有 transport 與第五參數。

驗證：`npm run check`、`npm test`、`npm run test:ui -- http://127.0.0.1:8001 --layout=repository --without-backend`（另測 standalone）。測試僅使用假 API／假憑證，攔截 ST 設定／聊天保存，不呼叫付費服務。
