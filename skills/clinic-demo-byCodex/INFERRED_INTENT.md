# LLM 推测任务意图

> 本文件由 Codex 根据 `intent.md`、`codegen.spec.ts`、`trace_evidence.json` 推测生成。
> 它是执行与 recovery 的参考说明，不是工程事实层，也不代表用户逐字确认过。

## 任务目标假设

`intent.md` 仍是占位内容，因此任务目标主要从 Playwright codegen 和 trace facts 推断：在 ClinicalTrials.gov 上搜索 `Diabetes`，筛选处于招募相关状态的临床试验，再应用性别和年龄筛选，选择结果列表中的前若干条记录，并通过站点下载功能导出选中记录。

该任务是公开网站上的查询、筛选和下载，风险标记为 `read_only`。

## 参数含义假设

- `condition`：最终选择的疾病/条件，录制值为 `Diabetes`，来自 codegen action 3 和 trace `call@14`。
- `conditionSearchTerm`：自动补全输入片段，录制值为 `dia`，来自 codegen action 2 和 trace `call@12`。
- `status`：研究状态筛选，录制值为 `Recruiting and not yet`，trace `call@16` resolvedHtml 显示其内部 locator 为 `label[for="adv-radio-status1"]`。
- `sex`：性别筛选，录制值为 `Male`，trace `call@20` resolvedHtml 显示其内部 locator 为 `label[for="adv-radio-sex2"]`。
- `ageGroup`：年龄筛选，录制值为 `Child (birth - 17)`，trace `call@22` resolvedHtml 显示其内部 locator 为 `label[for="adv-check-age-0"]`。
- `resultCount`：选择搜索结果数量。录制选择了前三条结果，trace `call@26`、`call@28`、`call@30` resolvedHtml 分别对应 `hit-sel-0`、`hit-sel-1`、`hit-sel-2`。这些 DOM id 只作为内部证据，不作为用户输入参数。
- `downloadDir`：本地下载保存目录，不来自页面轨迹，是执行环境参数。

## 业务步骤归纳

1. 打开 ClinicalTrials.gov 首页。
   - codegen line 4，trace `call@8`。
   - trace logs 显示直接导航到 `https://clinicaltrials.gov/` 成功。

2. 输入疾病条件并选择自动补全结果。
   - codegen lines 5-7，trace `call@10`、`call@12`、`call@14`。
   - `call@10/call@12` logs 显示 `Condition/disease` combobox 可见、可编辑并成功 fill。
   - `call@14` logs 显示 `Diabetes` option 被成功点击。

3. 选择研究状态并提交搜索。
   - codegen lines 8-9，trace `call@16`、`call@18`。
   - `call@16` resolvedHtml 显示 `Recruiting and not yet` 对应 `label[for="adv-radio-status1"]`。
   - `call@20` 的 URL delta 显示搜索结果 URL 出现 `cond=Diabetes`、`aggFilters=status:not rec`、`viewType=Card`。

4. 应用性别和年龄筛选。
   - codegen lines 10-12，trace `call@20`、`call@22`、`call@24`。
   - `call@20` resolvedHtml 显示 `Male` 对应 `label[for="adv-radio-sex2"]`。
   - `call@22` resolvedHtml 显示 `Child (birth - 17)` 对应 `label[for="adv-check-age-0"]`。
   - `call@24` 的 verifier candidate 显示 `aggFilters` 从 `status:not rec` 变化为 `ages:child,sex:m,status:not rec`。

5. 选择搜索结果记录。
   - codegen lines 13-15，trace `call@26`、`call@28`、`call@30`。
   - 录制动作选择了前三条结果，Playwright logs 显示每个 label 都 resolved 且 visible/enabled/stable。
   - verifier 不使用宽泛 `3 selected` 文本，因为 trace evidence 提示该文本有重复副本风险；脚本改为验证 `input[id^="hit-sel-"]:checked` 数量等于 `resultCount`。

6. 打开下载弹窗。
   - codegen lines 16-19，trace `call@32`、`call@37`。
   - `call@32` resolvedHtml 显示下载入口为 `#action-bar-download-btn`，`aria-label="download"`。
   - `call@32` 的 dialog-like candidate 显示 `#download-modal` class 变为 `usa-modal-wrapper is-visible`，但该候选明确不能证明 wrapper 自身可见。
   - 该 step 只验证弹窗已打开、标题出现，以及 Results to Download 中 `${resultCount} selected` 已选中。

7. 点击弹窗内部最终 Download 按钮并下载文件。
   - `call@37` resolvedHtml 显示最终按钮为 `<button ...> Download </button>`。
   - `call@37` logs 显示 Playwright 在点击前执行了 `scrolling into view if needed`，说明按钮可能位于弹窗下方，不适合作为上一 step 的 `toBeVisible()` verifier。
   - 脚本让 Playwright 直接点击该按钮，并以 `download` 事件和本地文件大小作为最终 verifier。

## Verifier 设计依据

- 首页：验证 `Condition/disease` combobox 可见。
- 条件选择：验证 combobox value 为 `condition`。
- 搜索提交：验证进入 `/search` URL 且结果卡片出现，并检查 `cond` 与状态 query。
- 筛选应用：验证 `aggFilters` 包含状态、年龄和性别 token，并验证结果卡片可见。
- 结果选择：验证 checked 的结果 checkbox 数量等于 `resultCount`。
- 打开下载弹窗：验证 `#download-modal` 打开状态、标题和 `${resultCount} selected` 选项。
- 下载：点击弹窗内部 `Download` 按钮，等待 download event，保存文件，并验证文件大小大于 0。

## 不确定点和人工审查

- `status`、`sex`、`ageGroup` 当前只为录制中出现的值和少量相邻值建立了内部映射；如果要支持更多筛选项，应从新的 trace evidence 中补充业务值到 locator 的映射。
- `resultCount` 表达的是“选择当前排序下的前 N 条结果”。如果业务要求固定选择特定 NCT ID，应改为 `nctIds` 或稳定标题参数，并重新生成 locator 策略。
- ClinicalTrials.gov 的筛选计数会随数据变化，因此脚本不依赖 `Male (2,623)` 或 `Child (birth - 17) (399)` 这类带计数文本。
