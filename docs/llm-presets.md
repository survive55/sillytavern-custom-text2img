# 生圖提示詞 LLM 預設

這裡指 **SillyTavern Chat Completion 的提示詞預設**，不是 ComfyUI workflow／圖片參數預設。預設用於獨立的文字 LLM 請求，最終圖片提示詞再交給 NovelAI 或 ComfyUI；匯入角色扮演預設不會自動把它改寫成專業生圖提示詞模板，仍須檢查模型輸出。

## 使用方式

1. 在 ST 匯出 Chat Completion／Prompt Manager 預設 JSON。
2. 本插件 → 提示詞生成 → LLM 提示詞來源 → **匯入的 Chat Completion LLM 預設**。
3. 按 **匯入並選用 JSON**。最多 20 份、每份 2 MiB；同名另存編號，錯誤檔案不覆蓋原選擇。
4. 多組順序可選 `character_id`。有全域 `100001` 時預選它；只有一組時直接選用；沒有全域且有多組時必須自行選擇。
5. 選擇獨立 **Chat Completion Connection Manager profile**或**手動 OpenAI 相容 API**。點 assistant 樓層魔杖生成。
6. 可勾選此預設的 **獨立提示詞對話／HTML 互動面板**。含啟用中顯示正則的新匯入會自動勾选面板，但不會自動執行 JS。

匯入只存到插件自己的擴展設定，**不寫入或切換 ST 主預設、不修改主聊天連線／角色卡／正則／腳本**。內容會隨 ST 設定備份，請勿任意公開。

## 正文來源與選配清理

- 模板模式與預設模式都只讀 **assistant 樓層的 `mes` 正文**，範圍止於被點選樓層。不讀主聊天 user 樓層、`extra.reasoning`、後續樓層、DOM 渲染文字或畫面用 HTML。
- 來源篩選共用同一規則：排除 ST 的 `is_user`／`is_system` 與 narrator；若訊息另有明確 `role`，僅接受 `assistant`，不把 `role: user` 因缺少 `is_user` 而誤當 assistant。目標不是 assistant 時停止，不回退到別的樓層。**這不刪除匯入預設本身的 `role: user` 指令，也不影響獨立面板的新輸入。**
- 前文數量計算可用的 assistant 訊息。`{{message}}`、`{{history}}`、`{{lastMessage}}`、`{{lastChatMessage}}`、`{{lastCharMessage}}` 使用同一份文字副本；`{{lastMessageId}}` 保留目標 ST 樓層編號。讀取主聊天時 `{{lastUserMessage}}` 為空，**獨立面板中使用者新輸入的 user 訊息仍正常加入對話**。
- ST `openai.js` 的 `setOpenAIMessages` 將 `mes` 映射為 `content`、`is_user` 映射為角色，沒有因 `role: assistant` 自動清理內嵌標記。ST 已分離的思考位於 `extra.reasoning`，本插件不讀取。
- **正文額外清理預設為 `[]`（關閉）**，直接採用 ST 已保存的正文。不是固定要求 `<正文>` 或 `<content>` 包裹。
- 在「選配：樓層正文清理規則」編輯 JSON 陣列，依序套用 `findRegex`／`replaceString`。例如：

  ```json
  [{ "findRegex": "/<note>[\\s\\S]*?<\\/note>/gi", "replaceString": "" }]
  ```

- 「填入 thinking／think 清理範例」提供可編輯規則，移除文中多段穿插的思考區塊；未閉合的起始思考標記會移除其後文字。這只是選配範例，並非自動啟用。
- 無匹配時保留剩餘文字；前文清理後為空則略過，目標清理後為空、規則無效或逾時則停止，**不回退原始全文**。不修改 ST 原聊天紀錄。
- 原模板其餘 ST 巨集仍沿用舊行為；插件自有訊息引用受到上述來源限制。第三方自行註冊、可讀取其他聊天的巨集不屬於本插件控制範圍。匯入預設則完全不呼叫 ST 的全域巨集引擎。

## 提示詞組裝

- 支援完整 CC JSON：`prompts`、`prompt_order`；Prompt Manager `version: 1` 的 `full`／`character` 匯出（`data`、平面順序）；舊版 `main_prompt`、`nsfw_prompt`、`jailbreak_prompt`，包含刻意空白，不補 ST 預設角色扮演文字。
- 缺少順序時使用 ST 內建順序，不按 `prompts` 儲存順序，也不自動啟用所有自訂條目。
- 按 `identifier` 對應。**提示詞本身或所選順序任一處 `enabled:false` 都是關閉**；順序必須明確為 `true`。保留兩處原始開關，重新載入／切換不會丟失關閉標記。
- 保留原始 `role`，不將 `model` 改成 `assistant`。Relative 依 ST `Message` 行為，只為缺少或 falsy 角色補 `system`；其他角色交給傳輸／API，供應商可能拒絕。不因未使用的非標準角色拒絕整份匯入。
- In-Chat 僅注入精確的 `system`／`user`／`assistant`，其他角色不注入也不佔深度。角色／Persona 等欄位 marker 依 nullish 規則補 `system`；保存角色不變。
- 生成類型為 **quiet**：trigger 空白適用所有類型，否則必須含 `quiet`。
- Relative 按順序排列；In-Chat 按深度與 order 插入。深度計算独立歷史訊息，不計已插入段落。同深度／order／role 合併換行，角色排列 assistant → user → system。
- `chatHistory` 放入所選 assistant 正文與獨立對話。部分匯出未列出 marker 時補場景（PHI 前）；**明確停用不重新開啟 ST 歷史**。但使用者明確送出的獨立面板對話，仍附在組裝結果後，不會被悄悄丟掉。
- 支援角色描述、個性、場景、Persona、文字範例、new-chat／new-example／personality／scenario 格式。群聊使用被點選作者的原始卡片，保留說話者姓名；不是完整群聊卡片 join 策略。
- 世界書／未知 marker 略過並提示；不掃描世界書，不套用角色卡 main／PHI overrides，不改主卡片設定。

## 獨立變數與巨集

匯入預設的所有巨集處理在可終止 Worker 中完成，不呼叫 ST `substituteParamsExtended`、第三方巨集或 `eval`。

- 支援插件訊息／角色欄位引用，`setvar`／`getvar`／`addvar`／`incvar`／`decvar` 及相應 global 形式、`trim`、`newline`、`noop`、註解、`random`、`pick`、基本 `roll` 與日期時間。
- local/global **都是本次獨立生圖對話的命名空間**，不讀寫主聊天／全域變數；多輪之間保存，取消／結束／重整後丟棄。不用暫時切換全域狀態再還原的方式隔離。
- 變數中的鍵使用 Map；聊天／正則捕捉文字中的巨集外觀不再次當指令執行。
- 只展開啟用且適用 quiet 的提示詞。未支援巨集保留文字並警告，不暗中改用全域引擎。
- 單次巨集最多 20,000 次操作、16 層巢狀，文字上限 1 Mi 字元。這不是完整 ST／酒館助手巨集相容環境。

## 原生預設 Regex

- 只匯入 **`extensions.regex_scripts`**。`SPreset.RegexBinding.regexes` 即使同名／同 ID 也不合併，避免把不同版本執行兩次。最多 200 條。
- 保留顺序、`disabled`、`placement`、`markdownOnly`、`promptOnly`、`minDepth`／`maxDepth`、`trimStrings`、`substituteRegex`、`runOnEdit`（沒有主聊天編輯事件，不掛接它）。
- 僅處理 User Input／AI Output。User Input 在此指独立面板新送出的 user 訊息，不是已排除的主聊天 user 樓層。世界書、slash、reasoning 来源不執行。
- 未勾 prompt/display 的规则套在獨立副本接收階段；`promptOnly` 套在送出獨立歷史時，並用於最終提示詞候選的文字版本；`markdownOnly` 只建立回覆顯示版本。兩者可同時勾選。
- 深度 0 是独立上下文最新訊息，向前計數，包含新獨立 user／assistant 對話；**並非主聊天原始樓層編號差**。原始 ST 聊天被裁剪、排除 user 後，深度對象也會不同。
- 支援 `/pattern/flags`、裸 pattern、數字／命名捕捉群組、`{{match}}`、trim、find 巨集原樣／跳脫展開。捕捉文字不呼叫主聊天巨集。
- 主聊天／全域／角色卡正則不被讀取。所有正則在 Worker 執行，單次操作 4 秒逾時就終止，不阻塞 ST UI。
- 顯示產生的 HTML／JS **不寫回獨立原文、ST 聊天或後續 LLM 歷史**。最終圖片提示詞從文字版本產生，仍需檢查；不保證任意角色扮演輸出已是有效圖片 tags。

## HTML／JS 互動面板

1. 面板先顯示純文字與靜態 HTML（完整 HTML 文件或 fenced HTML）。不把匯入 HTML 附加到 ST 主 DOM。
2. 需在當次面板按 **本次對話啟用嵌入 JS**。沒有 `credentialless` 支援的瀏覽器只提供靜態預覽。
3. 舊版 `window.parent/window.top` 的輸入框／送出操作以有限相容層轉到假 `send_textarea`／`send_but`、本地 `SillyTavern.getContext()` 與設定副本。也可使用 `CMI.fill(text)`／`CMI.send(text)`。沒有主聊天 API、API Key、完整 ST 設定或持久化能力。
4. 「僅填入」只填插件自己的輸入框；腳本「直接送出」也只是提出送出請求。**必須由使用者在插件控制區按「確認送給提示詞 LLM（可能計費）」**才呼叫獨立 LLM，不信任子框傳來的 claimed-user-click。
5. 可多輪對話（最多 20 次回覆）。失敗不自動重送，也不提交失敗草稿到獨立對話狀態。可停用 JS 或取消面板。
6. 編輯最終圖片提示詞 → 採用 → **生圖確認**。即使原本關閉一般提示詞審閱，互動模式仍要求生圖確認；腳本不能直接呼叫圖片服務。

### 安全邊界與限制

- `sandbox="allow-scripts"`，**沒有 `allow-same-origin`、表單、彈窗、下載或 top-navigation 權限**；credentialless iframe、no-referrer。相容層重寫只是適配，不是隔離邊界。
- CSP 限制外部脚本、fetch／連線、子框、Worker、媒體、表單、base 等來源。父頁只接受該 frame 來源、opaque origin 與專屬 channel 的有限訊息；文字有長度／次數限制，frame 銷毀即移除 listener。
- **不是完全斷網／CPU 沙箱**：瀏覽器 iframe 的自行導向等不能僅靠 CSP 完全封鎖，惡意 JS 也可能耗盡分頁 CPU。不要在含敏感內容時啟用不可信脚本。iframe 只得到其顯示內容，不得到 host 金鑰／主聊天資料。
- 不支援外部 npm／CDN imports、完整酒館助手／STscript、任意主頁 DOM 操作、主聊天變數與事件。`tavern_helper.scripts` 不執行。不能宣稱所有預設腳本完整相容。

## 連線與生成參數

可攜參數：`temperature`、`top_p`、`frequency_penalty`、`presence_penalty`、非負整數 `seed`，亦接受對應舊欄位。`seed:-1` 不固定 seed。`openai_max_tokens` 優先於插件上限。

- 手動 API 只增加上述參數，URL／端點／模型／驗證永遠由使用者的連線欄位決定。
- Connection Manager 透過官方 `sendRequest`，保留**既有可信連線 profile 引用的 CC preset**作為 transport／驗證設定；匯入可攜參數透過第五參數覆寫。不重複組裝連線 preset 的 prompts。
- 不採用匯入 JSON 的網址、代理密碼、API Key、Headers、custom body、模型、工具。既有連線 preset 的自訂 body／後處理仍可能改寫最終 wire payload，與舊版一致。
- 非通用參數如 `top_k`、`min_p`、reasoning 會提示；「測試 LLM」仍是固定短句連通測試，不跑生圖預設。

## 相容與遷移

- 最低 ST 1.14.0，需支援 module Worker／現代 Web API 的瀏覽器。JS 互動另需 credentialless（如新版 Chromium）。
- 模板、Text Completion／Instruct、圖片參數及圖集保留；樓層來源按新規則限定 assistant 正文。
- 切回模板不刪預設。刪除預設需確認，然後恢復模板。
- **旧版已匯入項目需重新匯入原始 JSON**才能恢復未保存的 Regex、提示詞 enabled 或早期被改寫的 role。沒有原始資料時不猜測重建。
- 不提供完整 tokenizer／context-budget 截斷；過長時 API 可能拒絕，請減少前文／預設／對話輪次。`openai_max_context` 不當作輸出上限。
- ComfyUI 圖片參數預設的 LoRA／解析度／正負提示詞仍按原流程，與 LLM 預設分開。

## 實作依據與驗證

- [ST Prompt Manager](https://docs.sillytavern.app/usage/prompts/prompt-manager/)、[ST Regex](https://docs.sillytavern.app/extensions/regex/)。
- 本機 `public/scripts/PromptManager.js`、`preset-manager.js`、`openai.js`、`extensions/regex/engine.js`、`variables.js`、`reasoning.js`、`custom-request.js`、`extensions/shared.js`。
- `reasoning.js` 的 `parseReasoningFromString` 預設只在開頭匹配一段，依主聊天 reasoning 設定；本插件不因讀正文而修改這些設定。可選清理範例能處理多段穿插區塊。
- [MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)、[credentialless](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/IFrame_credentialless)。
- `npm run check`、`npm test`、`npm run test:ui -- http://127.0.0.1:8001 --layout=repository --without-backend`；另測 standalone／installed。
- `node scripts/smoke-preset.cjs http://127.0.0.1:8001 [本機預設JSON]`：可只取樣本的 Regex 測真實顯示脚本，不執行其提示詞、不保存使用者內容到測試碼。驗證真實 Worker 逾時、主 DOM／storage 隔離、無自動送出、父頁確認與多輪文字歷史。
- 測試只使用假 API／假憑證，攔截設定／聊天保存，不呼叫付費服務。
