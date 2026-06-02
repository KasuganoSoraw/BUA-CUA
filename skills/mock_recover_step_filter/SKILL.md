# mock_recover_step_filter

这是一个用于验证 `ctx.recoverStep` 的 mock Task Skill。

它不提供 Playwright primary path，而是直接让 recovery agent 根据当前 step 的目标、hints、截图和局部 DOM 工具打开 `Subnet` 表头右侧的筛选按钮。

