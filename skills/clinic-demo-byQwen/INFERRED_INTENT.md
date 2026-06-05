# LLM 推测任务意图

> 本文件由 LLM 根据 `intent.md`、`codegen.spec.ts`、`trace_evidence.json` 和可选 recorder evidence 推测生成。
> 它是执行与 recovery 的参考说明，不是工程事实层，也不代表用户逐字确认过。

## 任务目标假设
用户意图在 ClinicalTrials.gov 上检索特定疾病（如 Diabetes）的临床试验，通过状态、性别、年龄进行多维度筛选，手动挑选若干符合条件的研究记录，并最终下载选中数据。

## 参数含义假设
- `condition`: 对应 codegen 中的 `fill('dia')` 及 `click('Diabetes')`，推测为疾病搜索关键字。
- `status`: 对应 `click('Recruiting and not yet')`，推测为试验招募状态。
- `gender` / `ageGroup`: 对应 `click('Male (2,623)')` 与 `click('Child (birth - 17) (399)')`，推测为受试者人口学特征筛选。
- 选中数量：trace 中连续勾选了第 1、4、5 张卡片，最终显示 `3 selected`。推测业务意图为“选择前几项或特定数量的结果”。

## 模型归纳出的业务步骤与证据映射
1. **导航至首页**
   - 对应 trace: `call@8` (`page.goto`)
   - 状态变化: `about:blank` -> `https://clinicaltrials.gov/`
2. **输入并选择疾病条件**
   - 对应 trace: `call@10` (click combobox), `call@12` (fill 'dia'), `call@14` (click option 'Diabetes')
   - 状态变化: 输入框激活 -> 自动补全列表展开 -> 选中值回填
3. **选择研究状态并执行搜索**
   - 对应 trace: `call@16` (click status text), `call@18` (click Search button)
   - 状态变化: URL 更新携带 `cond=Diabetes&aggFilters=status:not%20rec`，页面出现 `Clear Filters (4)`
4. **应用性别与年龄筛选**
   - 对应 trace: `call@20` (click Male), `call@22` (click Child), `call@24` (click Apply Filters)
   - 状态变化: URL 追加 `sex:m,ages:child`，页面显示 `Loading results…` 后刷新
5. **选择目标临床试验记录**
   - 对应 trace: `call@26` (1st card), `call@28` (4th card), `call@30` (5th card)
   - 状态变化: 顶部状态栏依次显示 `1 selected` -> `2 selected` -> `3 selected`
6. **导出选中记录**
   - 对应 trace: `call@32` (click download icon), `call@37` (click Download in modal)
   - 状态变化: 触发 `download` 事件，弹窗关闭

## Verifier 设计依据
- 搜索与筛选步骤依赖 URL 参数变化及 `Clear Filters` / `Apply Filters` 按钮的显隐状态。
- 选择步骤依赖顶部状态栏的 `X selected` 文本。
- 下载步骤依赖 Playwright `download` 事件及弹窗内按钮的消失。

## 不确定点与人工审查建议
- **动态计数文本**：trace 中的 `Male (2,623)` 包含实时统计数字，脚本已改为仅匹配 `Male` 文本，需人工确认该策略在数据量变化时是否稳定。
- **卡片选择索引**：trace 硬编码了 `nth-child(4)` 和 `nth-child(5)`，本 Skill 改为选择前 3 个可见卡片以增强泛化性。若业务要求固定特定 NCT ID，需引入基于标题文本的 locator。
- **下载格式**：trace 未明确下载文件格式（CSV/Excel），实际执行时取决于网站默认设置或弹窗选项，建议首次运行时检查下载目录文件完整性。
