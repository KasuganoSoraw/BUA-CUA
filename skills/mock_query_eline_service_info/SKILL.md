# mock_query_eline_service_info

这是一个用于验证 MVP Runtime 的 mock 任务级 Skill，不依赖真实企业 GUI。

## 参数

- `neKeyword`：搜索关键字。
- `neName`：期望打开的 NE 显示名称。
- `fields`：需要提取或确认存在的业务字段。

## 步骤

1. 加载 mock NMS 页面。
2. 搜索目标 NE。
3. 打开 E-Line Service 视图。
4. 提取并验证请求字段。

每个业务步骤都以 Playwright 作为主路径，并保留 Midscene fallback 的代码形态，方便后续真实 Skill 按同样结构生成。
