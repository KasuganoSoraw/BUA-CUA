# mock_table_filter_recovery

这是 Step Recovery Agent 的 mock demo。

页面中包含一个表格，`Subnet` 表头右侧有一个无 `aria-label` 的筛选按钮。primary 路径故意使用不存在的 accessible name，因此会失败并进入 `ctx.withRecovery`。

## 目标

验证 step-level recovery 链路：

1. primary 失败。
2. recovery agent 可使用 `jsProbe`、`domAct`、`clickAt` 等工具尝试打开筛选面板。
3. 没有配置 recovery 模型时，记录跳过并进入 fallback。
4. verifier 验证筛选面板打开。

## 参数

无参数。
