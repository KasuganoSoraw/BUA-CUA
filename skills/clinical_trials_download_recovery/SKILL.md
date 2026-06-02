# clinical_trials_download_recovery

这是一个真实网站的 recovery-driven Task Skill demo。

目标是在无需 Playwright codegen 的情况下，由 `index.ts` 拆解业务步骤，再通过 `ctx.recoverStep` 让 recovery agent 操作 ClinicalTrials.gov：

1. 搜索临床研究关键词。
2. 应用招募状态筛选。
3. 打开 Download 弹窗并下载 CSV。

该 demo 用于验证“无 codegen 的 Task Skill 执行态”，不是通用 browser agent。每个 step 都有明确目标和 verifier。

