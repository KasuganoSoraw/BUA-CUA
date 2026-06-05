# LLM 推测任务意图

> 本文件由 Codex 根据 `intent.md`、`codegen.spec.ts`、`trace_evidence.json` 和生成 prompt 推测生成。
> 它是执行与 recovery 的参考说明，不是工程事实层，也不代表用户逐字确认过。

## 任务目标假设

用户在 ClinicalTrials.gov 上完成一次公开临床试验结果筛选与下载流程：进入首页，搜索疾病条件 `Diabetes`，选择 “Recruiting and not yet” 状态，进入结果页后选择 `Male` 和 `Child (birth - 17)` 筛选，勾选三个结果卡片，并在下载弹窗中触发下载。

## 参数含义假设

- `condition`：最终要从自动补全选项中选择的疾病/条件名称。trace 中为 `Diabetes`。
- `conditionSearchTerm`：为了触发自动补全输入的搜索片段。codegen 中为 `dia`。
- `selectedResultIds`：结果卡片复选框的 DOM id。trace 中三次勾选分别解析到 `hit-sel-0`、`hit-sel-1`、`hit-sel-2`。
- `downloadDir`：保存下载文件的本地目录。

## 归纳步骤与证据

1. 打开 ClinicalTrials.gov 首页。
   - codegen line 4，trace `call@8`。
   - 证据：URL 从 `about:blank` 变为 `https://clinicaltrials.gov/`。
2. 输入疾病条件并选择自动补全项。
   - codegen line 5-7，trace `call@10`、`call@12`、`call@14`。
   - 证据：`Condition/disease` combobox 的 resolvedHtml 为 `input#advcond`，自动补全 option 选择 `Diabetes`。
3. 选择研究状态并提交搜索。
   - codegen line 8-9，trace `call@16`、`call@18`。
   - 证据：状态 label 解析为 `label[for="adv-radio-status1"]`，搜索按钮 resolvedHtml 为 `button Search`。
4. 应用性别和年龄筛选。
   - codegen line 10-12，trace `call@20`、`call@22`、`call@24`。
   - 证据：`Male` 对应 `label[for="adv-radio-sex2"]`，`Child (birth - 17)` 对应 `label[for="adv-check-age-0"]`；Apply Filters 后 URL 包含 `ages:child,sex:m,status:not%20rec`。
5. 勾选三个结果卡片。
   - codegen line 13-15，trace `call@26`、`call@28`、`call@30`。
   - 证据：三次点击分别 resolved 到 `label[for="hit-sel-0"]`、`label[for="hit-sel-1"]`、`label[for="hit-sel-2"]`；after text sample 出现 `Clear (3)` 与 `3 selected`。
6. 打开下载弹窗并确认下载。
   - codegen line 16-18，trace `call@32`、`call@37`。
   - 证据：下载入口为 `#action-bar-download-btn`，确认按钮为 `button Download`，原始 codegen 使用 `page.waitForEvent('download')` 捕获下载。

## Verifier 设计依据

- 对搜索与筛选，优先验证最终 URL 参数和关键可见区域，而不是短暂 loading 文本。
- 对结果卡片选择，优先验证对应 checkbox 的 checked 状态，避免使用可能命中隐藏下载选项的 `getByText('3 selected').toBeVisible()`。
- 对下载，使用 Playwright download event 和文件大小作为最终 verifier。

## 不确定点与人工审查

- `selectedResultIds` 来自本次 trace 的结果卡片 DOM id，适合复现录制轨迹；如果搜索结果排序变化，业务上可能应改用 NCT ID 或卡片标题定位。
- 筛选项计数会变化，因此脚本不依赖 `Male (2,623)` 或 `Child ... (399)` 的数字，而使用 trace 解析出的 `for` 属性。
- `intent.md` 和 `steps.md` 仍是占位文本，以上任务目标完全由 codegen 和 trace evidence 推断。
