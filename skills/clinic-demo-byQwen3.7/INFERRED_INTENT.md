# LLM 推测任务意图

> 本文件由 LLM 根据 `intent.md`、`codegen.spec.ts`、`trace_evidence.json` 和可选 recorder evidence 推测生成。
> 它是执行与 recovery 的参考说明，不是工程事实层，也不代表用户逐字确认过。

## 任务目标假设
用户希望在 ClinicalTrials.gov 上自动化搜索特定疾病（如 Diabetes）的临床试验，应用招募状态、性别和年龄组等多维度筛选条件，从结果中选中前 N 个试验，并下载这些试验的详细信息。

## 参数含义假设
- `condition`: 映射到首页的 "Condition/disease" 自动补全输入框。
- `status`: 映射到高级筛选中的 "Status" 单选按钮（如 "Recruiting and not yet"）。
- `sex`: 映射到搜索结果页的 "Sex" 单选按钮（如 "Male"）。
- `ageGroup`: 映射到搜索结果页的 "Age" 复选框（如 "Child (birth - 17)"）。
- `resultCount`: 映射到需要勾选的搜索结果卡片数量。录制中选择了第 1、4、5 个卡片（共 3 个），此处抽象为选择前 N 个，以增强脚本鲁棒性。

## 模型归纳出的业务步骤与证据

### 1. 搜索目标疾病
- **操作**：打开网站，在 "Condition/disease" 输入 "dia" 并选择 "Diabetes"。
- **证据**：`call@12` (fill 'dia'), `call@14` (click 'Diabetes')。Playwright logs 显示 locator resolved 且 click action done。

### 2. 选择状态并执行搜索
- **操作**：点击 "Recruiting and not yet"，然后点击 "Search"。
- **证据**：`call@16`, `call@18`。URL 变化证据：`cond=Diabetes&aggFilters=status:not%20rec&viewType=Card`。

### 3. 应用性别与年龄筛选
- **操作**：点击 "Male"，点击 "Child (birth - 17)"，点击 "Apply Filters"。
- **证据**：`call@20`, `call@22`, `call@24`。URL 变化证据：`aggFilters` 更新为 `ages:child,sex:m,status:not rec`。

### 4. 选择目标试验卡片
- **操作**：依次勾选搜索结果中的卡片。
- **证据**：`call@26`, `call@28`, `call@30`。状态变化证据：页面文本从 "1 selected" 变为 "2 selected" 最终变为 "3 selected"。
- **注意**：codegen 使用了 `nth-child(4)` 和 `nth-child(5)`，这可能是因为分页或特定视图下的索引。在生成 Skill 时，应抽象为“依次勾选前 N 个可见卡片”，避免硬编码 nth-child。

### 5. 打开弹窗并下载
- **操作**：点击顶部下载按钮，在弹窗中点击 "Download"。
- **证据**：`call@32` (打开弹窗，`download-modal` class 变为 `is-visible`)，`call@37` (点击下载，触发 download 事件)。

## Verifier 设计依据
- **URL 参数**：对于搜索和筛选步骤，使用 `toHaveURL` 或检查 URL 包含特定 query param（如 `cond=Diabetes`, `aggFilters=...`）作为强 verifier。
- **选中状态**：使用 `getByText(/\d+ selected/)` 验证选中数量，避免使用宽泛的 `getByText('Clear (3)')` 以防文本歧义。
- **下载事件**：使用 `page.waitForEvent('download')` 验证下载是否成功触发，这是最可靠的业务状态 verifier。

## 不确定点和需要人工审查的地方
1. **卡片选择逻辑**：录制中选择了第 1、4、5 个卡片，跳过了 2、3。这可能是因为 2、3 是广告、置顶或不可选。Skill 实现时需确保只勾选有效的、带有复选框的临床试验卡片，而不是盲目按 DOM 顺序点击。
2. **筛选面板的展开/折叠**：在应用性别和年龄筛选时，如果侧边栏默认折叠，可能需要先点击展开对应的筛选组。codegen 中直接点击了 label，说明录制时面板已展开或点击 label 自动展开了面板。Recovery hints 中需包含“确保筛选面板已展开”的提示。
