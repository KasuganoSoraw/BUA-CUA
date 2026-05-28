# arxiv-demo

这是一个 arXiv 页面任务级 Skill，用于搜索论文、按相关性排序、打开指定结果的 PDF，并将 PDF 下载到本地目录。

## 参数

- `query`：搜索关键词，例如 `GUI LLM`。
- `sortBy`：排序方式，默认 `relevance`。
- `resultIndex`：打开第几个搜索结果，默认 `1`。
- `downloadDir`：PDF 保存目录，默认 `downloads`。

## 前置条件

- 不需要登录。
- 需要本地网络能够访问 `https://arxiv.org/`。
- 需要 Playwright Chromium 已安装。

## 步骤

1. 打开 arXiv 首页。
2. 在右上角搜索框输入查询词并搜索。
3. 在搜索结果页选择排序方式并点击 `Go`。
4. 打开指定结果的 PDF 链接。
5. 下载当前 PDF 到本地目录。

## Verifier 策略

- 首页加载后验证搜索框可见。
- 搜索后验证结果列表出现。
- 排序后验证仍停留在搜索结果页。
- 打开 PDF 后验证 URL 包含 `/pdf/`。
- 下载后验证本地 PDF 文件存在且大小大于 0。

## 人工审查注意事项

该 Skill 为只读任务，但会向本地写入下载的 PDF 文件。首次执行前应确认 `downloadDir` 指向预期目录。
