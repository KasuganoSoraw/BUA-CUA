# clinic-demo

## 任务目的

在 ClinicalTrials.gov 上搜索指定疾病，应用研究状态、性别和年龄筛选，选择当前结果列表中的前若干条记录，并下载选中记录。

## 必需参数

- `condition`：疾病或条件名称，默认 `Diabetes`。
- `conditionSearchTerm`：用于触发自动补全的输入片段，默认 `dia`。
- `status`：研究状态筛选，当前支持 `Recruiting and not yet`。
- `sex`：性别筛选，当前支持 `Male`、`Female`、`All`。
- `ageGroup`：年龄筛选，当前支持 `Child (birth - 17)`。
- `resultCount`：选择搜索结果前 N 条，默认 `3`。
- `downloadDir`：下载文件保存目录，默认 `downloads`。

## 前置条件

- 本地网络可以访问 `https://clinicaltrials.gov/`。
- 浏览器上下文允许下载文件。
- 若 Playwright primary path 失败，runtime 可使用 recovery agent 和 Midscene fallback。

## 步骤大纲

1. 打开 ClinicalTrials.gov 首页。
2. 在 `Condition/disease` 中输入搜索片段并选择自动补全疾病。
3. 选择研究状态并点击 `Search`。
4. 在结果页应用性别和年龄筛选，再点击 `Apply Filters`。
5. 选择搜索结果列表中的前 `resultCount` 条记录。
6. 打开下载弹窗，确认下载配置状态。
7. 点击弹窗内部最终 `Download` 按钮并保存文件。

## Verifier 策略

- 以业务 step 为单位验证，不对每个底层 click/fill 机械断言。
- 首页和输入步骤验证可见控件和值。
- 搜索和筛选步骤验证 URL/query 参数与结果卡片。
- 结果选择步骤验证 checked checkbox 数量，避免使用宽泛 `3 selected` 文本。
- 打开下载弹窗步骤验证弹窗打开状态、标题和 `${resultCount} selected` 配置，不要求底部最终 `Download` 按钮已经在当前视口可见。
- 下载步骤直接点击弹窗内部 `Download` 按钮，让 Playwright 自动滚动到目标，并用 `download` 事件和本地文件大小验证。

## 人工审查注意事项

该 Skill 是公开网站只读查询和下载任务，风险为 `read_only`。当前 `status`、`sex`、`ageGroup` 的内部 locator 映射来自录制 trace；若需要支持更多筛选项，应重新录制或补充 trace evidence。`resultCount` 表示选择当前排序下的前 N 条结果，不保证对应固定 NCT ID。
