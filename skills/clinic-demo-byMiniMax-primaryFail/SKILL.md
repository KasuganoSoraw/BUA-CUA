# clinic-demo Task Skill

## 任务目的

本 Skill 用于在 `https://clinicaltrials.gov/` 上执行一次公开临床试验检索：

1. 在首页的 `Condition/disease` 组合框中输入并选择疾病条件；
2. 选择研究状态；
3. 执行搜索；
4. 在结果页选择性别与年龄组筛选条件并应用；
5. 勾选指定数量的搜索结果卡片；
6. 打开下载弹窗并点击 `Download`，触发文件下载。

根据 trace，本任务只读访问公开网站并下载结果文件，不会创建、修改或删除远端数据，因此风险级别为 `read_only`。

## 必需参数

- `condition`：疾病/条件名称。录制中为 `Diabetes`。
- `status`：研究状态。当前证据只覆盖 `Recruiting and not yet`。
- `sex`：性别筛选值。当前证据只覆盖 `Male`。
- `ageGroup`：年龄组筛选值。当前证据只覆盖 `Child (birth - 17)`。
- `resultCount`：需要勾选并下载的结果数量。录制中为 `3`。

参数均为用户可用自然语言表达、或页面上通过稳定业务文案定位的值；没有把 `adv-radio-sex2`、`adv-check-age-0`、`hit-sel-0` 等 DOM 内部 id 暴露为输入参数。

## 前置条件

- 不需要登录态；`requiresSession` 为 `false`。
- 需要运行环境允许访问 `https://clinicaltrials.gov/`。
- 需要浏览器上下文允许下载文件。
- 第一次连接真实系统执行前，应由人工审查生成的执行脚本与下载路径处理逻辑。

## 生成的步骤大纲

1. 打开 ClinicalTrials.gov 首页。
2. 在 `Condition/disease` 输入框中输入疾病条件的前缀或名称，并从自动补全中选择目标条件。
3. 选择研究状态 `Recruiting and not yet`。
4. 点击 `Search` 进入搜索结果页。
5. 在结果页选择 `Male` 与 `Child (birth - 17)` 筛选项。
6. 点击 `Apply Filters`，等待 URL 中的聚合筛选参数更新。
7. 勾选前 `resultCount` 个搜索结果卡片。
8. 点击页面顶部/操作栏中的下载按钮，打开下载弹窗。
9. 在下载弹窗中点击 `Download` 并等待 Playwright download event。

## verifier 策略

建议执行脚本中的 verifier 以业务状态为主：

- 首页加载：验证当前 URL 为 `https://clinicaltrials.gov/`，并验证 `Condition/disease` combobox 可操作。
- 条件与状态搜索：点击 `Search` 后，优先验证 URL query 参数包含 `cond=<condition>`、`aggFilters=status:not rec`、`viewType=Card`。trace 中 action `call@20` 显示这些参数是在进入结果页时出现的。
- 应用性别/年龄筛选：点击 `Apply Filters` 后，优先验证 URL query 参数 `aggFilters` 包含 `ages:child,sex:m,status:not rec`。trace 中 action `call@24` 提供了该 URL 状态变化。
- 选择结果：优先验证页面中选中计数达到 `${resultCount} selected`，但需注意 trace 对此类文本给出 `textAmbiguityWarning`，执行脚本应尽量限定到选择/操作栏区域或下载相关状态区域，避免宽泛 `getByText(...).toBeVisible()`。
- 打开下载弹窗：验证 `#download-modal` 的 class 从 `is-hidden` 变为 `is-visible`，或验证弹窗内部稳定标题/按钮可见。trace 中 action `call@32` 显示 `download-modal` 变为 `usa-modal-wrapper is-visible`。
- 确认下载：通过 Playwright `page.waitForEvent('download')` 验证真实下载事件触发。trace 中 codegen 已使用该方式等待下载。

## 人工审查注意事项

- 本任务会下载 ClinicalTrials.gov 的搜索结果数据。虽然属于只读下载，但仍需确认下载内容、保存路径和后续文件处理符合使用方的数据合规要求。
- trace 中结果卡片勾选使用了 `.selection > .usa-checkbox__label`、`ctg-search-hit-card:nth-child(...)` 等相对不稳定选择器。执行脚本应优先用结果卡片组件内的复选框/标签数量顺序定位，并为该步骤配置 recovery。
- trace 未提供下载弹窗内格式选项的选择证据；录制流程直接点击默认 `Download` 按钮。因此生成脚本不应假设或修改下载格式。
