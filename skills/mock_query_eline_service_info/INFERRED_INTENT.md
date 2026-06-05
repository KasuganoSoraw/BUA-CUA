# LLM 推测任务意图

> 本文件由 LLM 根据示例 `intent.md`、`codegen.spec.ts`、`trace_evidence.json` 和可选 recorder evidence 的生成约定推测生成。
> 它是执行与 recovery 的参考说明，不是工程事实层，也不代表用户逐字确认过。

## 任务目标假设

在模拟 NMS 页面中，根据 `neKeyword` 搜索目标 NE，打开匹配的 E-Line Service 信息页，并确认用户请求的字段存在。

## 参数含义假设

- `neKeyword`：用于搜索目标 NE 的关键字。
- `neName`：搜索结果中期望打开的目标 NE 名称。
- `fields`：进入 E-Line Service 后需要确认存在的字段列表。

## 归纳步骤

1. 加载 mock NMS 页面。
2. 在 `Search NE` 输入框中输入 `neKeyword` 并点击 `Search`。
3. 在搜索结果中打开 `neName` 对应的对象。
4. 在 E-Line Service 表格中验证 `fields` 指定的列头存在。

## Verifier 依据

- 搜索后应出现 `Open ${neName}` 按钮。
- 打开对象后应出现 `E-Line Service` 标题。
- 提取字段步骤应能看到每个请求字段对应的 column header。

## 不确定点

这是 mock skill，未绑定真实 trace action id 或真实企业系统页面；它只用于验证 BUA-CUA Task Skill 契约。
