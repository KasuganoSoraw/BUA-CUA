# clinic-demo

## 任务目的

在 ClinicalTrials.gov 上复现一次公开临床试验结果筛选与下载流程：搜索 `Diabetes`，选择招募状态，应用性别和年龄筛选，勾选三个结果卡片，并触发下载。

## 参数

- `condition`：最终选择的疾病/条件名称，默认 `Diabetes`。
- `conditionSearchTerm`：自动补全输入片段，默认 `dia`。
- `selectedResultIds`：要勾选的结果 checkbox id，默认 `hit-sel-0`、`hit-sel-1`、`hit-sel-2`。
- `downloadDir`：下载文件保存目录，默认 `downloads`。

## 前置条件

- 本地网络可访问 `https://clinicaltrials.gov/`。
- Playwright 浏览器允许下载文件。
- Recovery 模型和 Midscene 模型可按需用于 fallback，但主路径尽量使用 Playwright locator。

## 步骤大纲

1. 打开 ClinicalTrials.gov 首页。
2. 在 `Condition/disease` 输入框输入搜索片段，并选择 `Diabetes` 自动补全项。
3. 选择 “Recruiting and not yet” 状态并点击 Search。
4. 在结果页应用 `Male` 和 `Child (birth - 17)` 筛选并点击 Apply Filters。
5. 勾选 trace 中对应的三个结果卡片 checkbox。
6. 打开下载弹窗，点击 Download，并保存下载文件。

## Verifier 策略

- 首页和搜索步骤验证 URL 与 `Condition/disease` 输入状态。
- 筛选步骤验证 URL 中出现 `ages:child`、`sex:m` 和 `status:not%20rec`。
- 勾选步骤验证 `#hit-sel-0`、`#hit-sel-1`、`#hit-sel-2` 的 checked 状态，不依赖隐藏文本。
- 下载步骤通过 `page.waitForEvent('download')`、本地保存文件存在和文件大小大于 0 验证。

## 人工审查注意事项

这是公开网站只读筛选和下载任务，风险标记为 `read_only`。不过结果列表顺序可能随网站数据变化而改变，如果业务目标不是“复现录制中前三个 checkbox”，后续应把 `selectedResultIds` 替换为更稳定的 NCT ID 或标题定位。
