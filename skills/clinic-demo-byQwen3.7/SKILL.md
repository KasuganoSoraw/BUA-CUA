# ClinicalTrials.gov 临床试验搜索与下载

## 任务目的
在 ClinicalTrials.gov 网站上根据用户指定的疾病条件、招募状态、性别和年龄组进行临床试验搜索，从结果中选择指定数量的试验，并下载其详细信息。

## 必需参数
- `condition` (string): 疾病或条件名称（如 Diabetes）。
- `status` (string): 招募状态（如 Recruiting and not yet）。
- `sex` (string): 性别（如 Male）。
- `ageGroup` (string): 年龄组（如 Child (birth - 17)）。
- `resultCount` (integer): 需要选择并下载的临床试验数量。

## 前置条件
- 能够访问 `https://clinicaltrials.gov/`。
- 无需登录，该网站为公开数据。

## 步骤大纲
1. **打开网站并输入搜索条件**：导航至 ClinicalTrials.gov，在 Condition/disease 下拉框中输入关键字并选择精确匹配项。
2. **选择状态并执行搜索**：勾选指定的招募状态，点击 Search 按钮，等待搜索结果页加载。
3. **应用高级筛选**：在搜索结果页的侧边栏或筛选面板中，选择指定的性别和年龄组，点击 Apply Filters 应用筛选。
4. **选择目标试验**：在搜索结果列表中，依次勾选前 `resultCount` 个临床试验卡片。
5. **下载选中数据**：点击顶部操作栏的下载按钮打开下载弹窗，确认选中数量后点击 Download 触发下载。

## Verifier 策略
- **搜索与筛选**：通过 URL 查询参数（`cond`, `aggFilters`）验证筛选条件是否成功应用。
- **选择试验**：通过页面出现的选中计数文本（如 `N selected`）验证是否成功勾选了正确数量的卡片。
- **下载**：通过监听 Playwright 的 `download` 事件验证文件是否成功触发下载。

## 风险与人工审查注意事项
- 本任务为只读操作（`read_only`），不涉及对远程系统状态的修改。
- 搜索结果的数量和顺序可能随时间变化，脚本需动态定位前 N 个卡片，而非硬编码 DOM 索引。
- 下载弹窗的打开和关闭状态需通过稳定的 class 或内部标题验证，避免依赖弹窗遮罩层。
