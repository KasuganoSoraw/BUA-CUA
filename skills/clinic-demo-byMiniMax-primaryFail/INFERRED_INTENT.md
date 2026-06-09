# LLM 推测任务意图

> 本文件由 LLM 根据 `intent.md`、`codegen.spec.ts`、`trace_evidence.json` 和可选 recorder evidence 推测生成。
> 它是执行与 recovery 的参考说明，不是工程事实层，也不代表用户逐字确认过。
>
> 本任务中用户未提供真实自然语言意图或人工步骤说明；以下内容是模型根据 codegen 与 `trace_evidence.json` 推断的人类任务意图，不是用户手写原始意图。

## 任务目标假设

模型推测：操作者希望在 ClinicalTrials.gov 上搜索与 `Diabetes` 相关、状态为 `Recruiting and not yet` 的临床试验；在结果页进一步筛选 `Male` 与 `Child (birth - 17)`；然后选择 3 条搜索结果并下载默认格式的结果文件。

该目标依据来自：

- codegen 第 4 行：打开 `https://clinicaltrials.gov/`；
- codegen 第 5-7 行：操作 `Condition/disease` combobox，填入 `dia`，选择自动补全项 `Diabetes`；
- codegen 第 8-12 行：选择 `Recruiting and not yet`，点击 `Search`，再选择 `Male`、`Child (birth - 17)` 并点击 `Apply Filters`；
- codegen 第 13-18 行：勾选 3 个搜索结果，点击下载入口和下载弹窗中的 `Download`。

## 参数含义假设

- `condition`：要在 `Condition/disease` 中选择的条件名称。录制值是 `Diabetes`。codegen 中实际先填入 `dia`，再选 `Diabetes`；对外参数采用用户可理解的最终条件名称，而不是把输入片段 `dia` 作为必须参数。
- `status`：研究状态筛选。trace 中 label 为 `Recruiting and not yet`，对应 action `call@16`。
- `sex`：结果页性别筛选。trace 中 label 为 `Male (2,623)`，对应 action `call@20`。括号中的数量可能随时间变化，因此参数只保留业务值 `Male`。
- `ageGroup`：结果页年龄筛选。trace 中 label 为 `Child (birth - 17) (399)`，对应 action `call@22`。括号中的数量可能随时间变化，因此参数只保留业务值 `Child (birth - 17)`。
- `resultCount`：要勾选的搜索结果数量。trace 中依次出现 `1 selected`、`2 selected`、`3 selected`，最终选择 3 条，对应 action `call@26`、`call@28`、`call@30`。

## 模型归纳出的业务步骤与证据

### 1. 打开 ClinicalTrials.gov 首页

- codegen 行号：第 4 行。
- trace action：`call@8`。
- 证据：`goto('https://clinicaltrials.gov/')` 成功；URL 从 `about:blank` 变为 `https://clinicaltrials.gov/`。
- verifier 设计依据：可验证 URL 为站点首页，并验证 `Condition/disease` combobox 存在。trace 的 `textAmbiguityWarning` 提示首页有重复/隐藏文本风险，因此不建议仅用宽泛文本断言。

### 2. 输入并选择条件/疾病

- codegen 行号：第 5-7 行。
- trace action：
  - `call@10`：点击 `getByRole('combobox', { name: 'Condition/disease' })`；
  - `call@12`：向该 combobox 填入 `dia`；
  - `call@14`：点击 `getByRole('option', { name: 'Diabetes', exact: true })`。
- 关键 DOM 证据：`call@10` 和 `call@12` 的 resolvedHtml 为带 `aria-label="Condition/disease"` 的 `<input id="advcond" type="search" role="combobox" ...>`；`call@14` 解析到 `role="option"` 的 `mat-option`。
- verifier 设计依据：可验证 combobox 最终值或已选择的条件名称；如果页面实现不暴露稳定 value，可在后续搜索结果 URL 的 `cond=Diabetes` 中验证该条件已生效。

### 3. 选择研究状态并执行搜索

- codegen 行号：第 8-9 行。
- trace action：
  - `call@16`：点击文本 `Recruiting and not yet`，resolvedHtml 为 `<label for="adv-radio-status1" class="usa-radio__label">...`；
  - `call@18`：点击 `Search` 按钮。
- 状态变化证据：`call@18` 本身没有立即记录 URL 变化，但下一步 `call@20` 的 before/after 显示 URL 已变为 `https://clinicaltrials.gov/search?cond=Diabetes&aggFilters=status:not%20rec&viewType=Card`。
- verifier 设计依据：搜索完成后应验证 URL query 参数：`cond=Diabetes`、`aggFilters=status:not rec`、`viewType=Card`。这些是 trace action `call@20` 的 `urlQueryParam` verifierCandidates。

### 4. 在结果页选择性别与年龄组筛选，并应用筛选

- codegen 行号：第 10-12 行。
- trace action：
  - `call@20`：点击 `Male (2,623)`，resolvedHtml 为 `<label for="adv-radio-sex2" class="usa-radio__label">...`；
  - `call@22`：点击 `Child (birth - 17) (399)`，resolvedHtml 为 `<label for="adv-check-age-0" class="usa-checkbox__label">...`；
  - `call@24`：点击 `Apply Filters`。
- 状态变化证据：
  - `call@20` 后 URL 包含 `cond=Diabetes`、`aggFilters=status:not rec`、`viewType=Card`；
  - `call@22` 后文本样本新增 `Clear Filters (5)`；
  - `call@24` 后 URL 的 `aggFilters` 从 `status:not rec` 变为 `ages:child,sex:m,status:not rec`。
- verifier 设计依据：点击 `Apply Filters` 后优先验证 `aggFilters` 包含 `ages:child`、`sex:m`、`status:not rec`。不建议把 `Loading results…` 当作必须出现的中间状态，因为它可能短暂或被跳过。

### 5. 勾选搜索结果卡片

- codegen 行号：第 13-15 行。
- trace action：
  - `call@26`：点击 `.selection > .usa-checkbox__label` 的第一个匹配项，resolvedHtml 为 `<label for="hit-sel-0" ...>`，文本样本新增 `1 selected`、`Clear (1)`；
  - `call@28`：点击 `ctg-search-hit-card:nth-child(4) ...`，resolvedHtml 为 `<label for="hit-sel-1" ...>`，文本样本新增 `2 selected`、`Clear (2)`；
  - `call@30`：点击 `ctg-search-hit-card:nth-child(5) ...`，resolvedHtml 为 `<label for="hit-sel-2" ...>`，文本样本新增 `3 selected`、`Clear (3)`。
- 证据说明：这些选择器包含 `nth-child` 和内部 hit id，属于页面实现细节，不适合作为用户参数。它们可以作为执行脚本内部的弱证据或 recovery hints。
- verifier 设计依据：可验证选择计数达到 `${resultCount} selected`，但 trace 对 `1 selected`、`2 selected`、`3 selected` 相关文本均给出 `textAmbiguityWarning`，因此执行脚本应尽量限定到选择状态栏、操作栏或下载弹窗相关区域，而不是全页面宽泛文本断言。

### 6. 打开下载弹窗

- codegen 行号：第 16 行。
- trace action：`call@32`。
- 关键 locator：`getByLabel('download', { exact: true })`。
- DOM 证据：resolvedHtml 为 `<button title="Download" aria-hidden="true" data-open-modal="" aria-label="download" id="action-bar-download-btn" aria-controls="download-modal" ...>`。
- 状态变化证据：`dialogLikeAdded` 显示 body 出现 `usa-js-modal--active`，`#download-modal` class 为 `usa-modal-wrapper is-visible`。
- verifier 设计依据：优先验证 `#download-modal` 具有打开状态，或验证弹窗内稳定的 `Download` 按钮可见。trace 明确提示 `dialogLikeState` 不应直接假定 wrapper 的 `toBeVisible()` 一定可靠。

### 7. 确认下载

- codegen 行号：第 17-19 行，其中第 17 行创建 `downloadPromise`，第 18 行点击下载按钮，第 19 行取得 download 对象。
- trace action：`call@37`。
- 关键 locator：`getByRole('button', { name: 'Download' })`。
- DOM 证据：resolvedHtml 为 `<button type="button" data-close-modal="" class="usa-button primary-button"> Download </button>`。
- 状态变化证据：`#download-modal` class 变为 `usa-modal-wrapper is-hidden`。
- verifier 设计依据：最强 verifier 是等待 Playwright `download` 事件。可附加验证弹窗关闭状态，但下载事件更直接证明业务动作完成。

## verifier 设计依据摘要

- URL query 参数是本任务中最强的搜索/筛选状态证据：
  - `call@20`：新增 `cond=Diabetes`、`aggFilters=status:not rec`、`viewType=Card`；
  - `call@24`：`aggFilters` 更新为 `ages:child,sex:m,status:not rec`。
- 选择结果数量可用 `3 selected` 类文本辅助验证，但 trace 已提示文本重复/隐藏风险，需要限定区域。
- 下载弹窗状态可参考 `#download-modal` 的 `is-visible` / `is-hidden` class，但更建议结合弹窗内部按钮和最终 download event。
- 对 radio/checkbox 类筛选，trace 中实际点击的是可见 label，例如 `Recruiting and not yet`、`Male (...)`、`Child (...)`。生成脚本时应避免把内部 id 当成业务输入；如果使用 role locator 不稳定，可使用 label 文本或 `label` 区域点击，并以 URL 参数作为最终 verifier。

## 不确定点和需要人工审查的地方

1. 用户没有提供真实自然语言意图；“搜索糖尿病、筛选男性儿童招募中/尚未招募研究并下载 3 条结果”是根据 codegen 和 trace 推断的。
2. codegen 在条件框中填入 `dia`，然后选择 `Diabetes`。执行脚本可以用 `condition` 推导输入片段，也可以直接填入完整 `Diabetes` 后选项；这一点需要在实际页面上验证自动补全行为。
3. trace 中 `Male (2,623)` 和 `Child (birth - 17) (399)` 的括号计数很可能动态变化。执行脚本不应依赖固定计数，只应定位业务文案 `Male` 与 `Child (birth - 17)`。
4. 搜索结果勾选使用了较脆弱的 DOM 顺序选择器和内部 id（如 `hit-sel-0`）。如果结果排序或页面结构变化，选择“前 3 条结果”的实现需要 recovery agent 或更稳的卡片定位策略。
5. trace 没有显示下载弹窗内是否存在文件格式、字段范围等选项；录制流程直接点击默认 `Download`。因此本 Skill 不应假设用户选择特定下载格式。
6. 下载文件名、文件类型和文件大小没有在 trace_evidence 中提供；执行脚本只能可靠等待 download event，具体保存与校验策略需人工审查后确定。
