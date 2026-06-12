# BUA-CUA Toolkit Agent 使用指引

本仓库是 **BUA-CUA Toolkit**，不是某个具体网页任务 Skill。其他 agent clone 本仓库后，可以使用它完成两件事：

- **生成 Task Skill**：根据 `intent.md`、Playwright `codegen.spec.ts` 和 `trace_evidence.json`，生成 `skill.json`、`SKILL.md`、`INFERRED_INTENT.md`、`index.ts`。
- **执行 Task Skill**：通过 `uv run bua-cua run-skill ...` 执行已经生成并经过人工审查的 Task Skill。

## 概念边界

- **BUA-CUA Toolkit**：本仓库整体，包含 prompt、schema、Python CLI、Node/TS Runtime、示例 Task Skill 和安装指引。
- **Task Skill Generator Guidance**：主要是 `prompts/task_skill_generation.md`，用于约束模型如何生成 Task Skill。当前 CLI 已提供 `uv run bua-cua generate-skill ...` 自动调用模型生成文件；agent 负责准备输入、运行命令、校验结果和反馈问题。
- **Task Skill Runner**：由 `uv run bua-cua run-skill ...` 调用，负责加载、校验、运行 Task Skill。
- **Natural Intent Runner**：由 `uv run bua-cua run-intent ...` 调用，负责从自然语言中选择 Task Skill、抽取参数、生成本次运行 args，并调用 Task Skill Runner。
- **Task Skill**：位于 `skills/<task_name>/` 的具体网页任务级混编脚本，使用 Playwright + Midscene。普通网页操作 step 默认通过 `ctx.withRecovery` 形成 `Playwright primary -> verifier -> step recovery agent/CDP -> verifier -> Midscene fallback -> verifier` 链路；`ctx.withFallback` 仅用于纯本地处理、纯断言或明确不允许 recovery 的高风险步骤。
- **Recovery-driven Task Skill**：没有 Playwright codegen 或稳定 primary path 时，`index.ts` 仍然拆分业务 step，但每个网页操作 step 可以直接调用 `ctx.recoverStep` 交给 step recovery agent 执行。

Runtime 不做 browser-use 式运行时自由规划。它只提供薄执行容器、参数校验、日志、失败截图和浏览器生命周期管理。

## 环境准备

1. Clone 仓库：

```powershell
git clone https://github.com/KasuganoSoraw/BUA-CUA.git
cd BUA-CUA
```

2. 安装 `uv`。

Windows 可使用官方安装脚本：

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
```

如果网络较慢，也可以先用已有 Python bootstrap 安装：

```powershell
python -m pip install uv -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
```

3. 安装并同步 Python 环境。本项目固定使用 Python `3.12.10`：

```powershell
uv python install 3.12.10
uv sync
```

4. 安装 Node 依赖：

```powershell
npm install
```

5. 安装 Playwright Chromium 浏览器：

```powershell
npx playwright install chromium
```

6. 配置 Midscene 模型环境变量。

复制 `.env.example` 为 `.env`，并按本地 Midscene provider 填写模型和密钥。Task Skill 不应硬编码模型密钥。

## 安装验证

确认 Python 版本：

```powershell
uv run python --version
```

预期输出包含：

```text
Python 3.12.10
```

运行 TypeScript 静态检查：

```powershell
npm run typecheck
```

校验 mock Task Skill：

```powershell
uv run bua-cua validate-skill mock_query_eline_service_info
```

执行 mock Task Skill：

```powershell
uv run bua-cua run-skill mock_query_eline_service_info --args .\skills\mock_query_eline_service_info\fixtures\input.example.json --headless
```

执行后会在 `runs/` 下生成 JSONL 日志。失败时 Runtime 会保存截图到 `runs/artifacts/`。

## 生成真实 Task Skill 工作流

1. 创建输入包：

```powershell
uv run bua-cua scaffold-input <task_name>
```

如果已经准备开始官方 Playwright codegen 录制，也可以直接使用一键命令，它会自动创建输入包并把录制脚本写入 `inputs/<task_name>/codegen.spec.ts`：

```powershell
uv run bua-cua codegen <task_name> --url <start_url>
```

已有 `codegen.spec.ts` 且不是占位内容时，该命令会先备份旧文件。确认要覆盖时使用：

```powershell
uv run bua-cua codegen <task_name> --url <start_url> --overwrite
```

对容易触发安全验证的网站，可以指定真实浏览器 channel 和独立持久化 profile：

```powershell
uv run bua-cua codegen <task_name> --url <start_url> --channel chrome --user-data-dir .\auth\codegen-chrome-profile
```

2. 填写自然语言任务描述：

```text
inputs/<task_name>/intent.md
```

3. 检查 Playwright codegen 录制脚本：

```text
inputs/<task_name>/codegen.spec.ts
```

4. 可选为 codegen 脚本生成 Playwright trace：

```powershell
uv run bua-cua trace-codegen <task_name>
```

该命令会自动编译 `inputs/<task_name>/codegen.spec.ts`，生成临时 Playwright config，并显式关闭 trace 临时目录的 gitignore 测试发现影响。不要要求用户手写 JS 脚本或手动复制编译产物。

生成目录：

```text
inputs/<task_name>/trace/
  trace.zip
  test-results/
```

查看 trace：

```powershell
npx playwright show-trace .\inputs\<task_name>\trace\trace.zip
```

`trace.zip` 用于补充 codegen 没有显式写出的 before/action/after 证据。它不替代 Task Skill 的 verifier 或 fallback。
即使 codegen 脚本中途失败，只要 Playwright 产生了 trace，`trace-codegen` 也会保留最新 `trace.zip` 供排查。

5. 可选提取 trace 工程证据：

```powershell
uv run bua-cua summarize-trace <task_name>
```

输出：

```text
inputs/<task_name>/trace/
  trace_evidence.json
  evidence-images/
```

`trace_evidence.json` 只包含工程提取的 facts，不包含模型生成的语义步骤。后续模型生成自然语言步骤、verifier 和 recovery hints 时，必须引用其中的 action id / snapshot / frame evidence。
同一命令还会输出 `api_candidates.json`，用于记录从 trace network 中发现的查询、自动补全、下载等候选 API。API candidate 不是 verified fast path，不能直接替代 GUI。

6. 可选探测并固化 API fast path：

```powershell
uv run bua-cua probe-api <task_name> --args .\skills\<task_name>\fixtures\input.example.json
```

`probe-api` 会读取 `skills/<task_name>/api_registry.json` 中的 candidate，请求只读查询/下载接口，成功后最多升级为 `probed`，并写入：

```text
runs/<timestamp>-<task>-api-probe/api_probe.jsonl
```

该命令只允许第一版 `risk: "read_only"` 的 Skill。它可以更新 `api_registry.json` 并覆盖写入 `API_PROBE.md` 作为最近一次探测摘要，但不得修改 `index.ts`、`SKILL.md` 或 `INFERRED_INTENT.md`。

如果需要现场观察 GUI 主线执行时触发的 API/network 请求，可以加：

```powershell
uv run bua-cua probe-api <task_name> --args .\skills\<task_name>\fixtures\input.example.json --observe-gui
```

这会先运行原 `index.ts` GUI 主线，并写出 `runs/<timestamp>-<task>-api-probe/api_observation.json`。该文件只记录同源 XHR/fetch/API/download 请求、query、状态码和小型响应摘要，是 API/option discovery 证据，不是 approved fast path。

7. 可选填写人工步骤说明：

```text
inputs/<task_name>/steps.md
```

8. 使用 OpenAI-compatible 模型生成 Task Skill。

```powershell
uv run bua-cua generate-skill <task_name>
```

如果 `skills/<task_name>/` 已存在且确认要覆盖：

```powershell
uv run bua-cua generate-skill <task_name> --overwrite
```

该命令会读取 `prompts/task_skill_generation.md`、`intent.md`、`codegen.spec.ts` 和 `trace_evidence.json`，调用 `.env` 中配置的模型生成 Skill 文件。Codex/agent 不应手写任务脚本内容，只负责运行命令、校验和反馈错误。

如需显式切换 provider，可以使用：

```powershell
uv run bua-cua generate-skill <task_name> --qwen --overwrite
uv run bua-cua generate-skill <task_name> --minimax --overwrite
```

生成目标目录：

```text
skills/<task_name>/
  skill.json
  SKILL.md
  INFERRED_INTENT.md
  api_registry.json
  knowledge.json
  index.ts
  fixtures/input.example.json
  recordings/codegen.spec.ts
```

`INFERRED_INTENT.md` 必须明确说明：该文件由 LLM 根据 `intent.md`、`codegen.spec.ts` 和 `trace_evidence.json` 推测生成，是执行与 recovery 的参考说明，不是工程事实层，也不代表用户逐字确认过。`skill.json` 应通过 `inferredIntent` 字段引用该文件。
如果生成 `api_registry.json`，`skill.json` 必须通过 `apiRegistry` 字段引用该文件。`api_registry.json` 只记录 API fast path 候选/验证信息，不得包含 API key、cookie、authorization header 或一次性 token。
如果生成 `knowledge.json`，`skill.json` 必须通过 `knowledge` 字段引用该文件。`knowledge.json` 只记录运行后显式沉淀的 GUI option mapping、recovery case 和 selector hint，不得包含 API fast path。

9. 人工审查生成结果。

重点检查：

- 是否保留了 codegen 中的人类业务顺序。
- 是否按页面状态转换切分 step。
- 每个关键网页操作 step 是否使用 `ctx.withRecovery`，并包含 Playwright primary、recoveryOptions、Midscene fallback 和 verifier。
- 是否识别并替换了明显不稳定 locator，例如动态 id、长随机 class、深层 CSS 链、过度 `nth()`。
- 是否只参数化业务数据，例如 NE 名称、搜索关键字、业务对象名、tab、字段、筛选值。
- 是否没有硬编码模型密钥。
- 如果包含 API fast path，是否只用于查询/导出/下载，且失败时能回退 GUI。
- 是否没有未经确认的危险写入操作。

10. 校验 Task Skill：

```powershell
uv run bua-cua validate-skill <task_name>
npm run typecheck
```

11. 本地 headed 执行真实 Task Skill：

```powershell
uv run bua-cua run-skill <task_name> --args .\skills\<task_name>\fixtures\input.example.json
```

如果该 Skill 已经有 `probed` 或 `approved` 的只读 API fast path，可以优先尝试 API：

```powershell
uv run bua-cua run-skill <task_name> --args .\skills\<task_name>\fixtures\input.example.json --api-first
```

`--api-first` 失败时会记录原因并回退到原 `index.ts` GUI 主线。`candidate` 状态不会被正式执行；写操作或破坏性操作也不会自动 API-first。

12. 面向最终用户的自然语言执行入口：

```powershell
uv run bua-cua run-intent "<用自然语言描述要完成的网页任务>" --minimax
```

如果已经知道要使用哪个 Skill，可以固定 Skill，只让模型抽取参数：

```powershell
uv run bua-cua run-intent "<用自然语言描述该 Skill 的本次参数>" --skill <task_name> --dry-run --minimax
```

`run-intent` 会写入：

```text
runs/<timestamp>-intent/
  intent_resolution.json
  args.json
```

`fixtures/input.example.json` 只是录制样例和 schema 示例，不代表用户本次真实输入。`run-intent` 生成的 `args.json` 才是本次执行实际使用的参数。

`run-intent --api-first` 的顺序是：先解析自然语言意图和参数，再把生成的 args 交给现有 `run-skill --api-first`。API fast path 是执行优化，不参与 skill 选择和参数抽取。

13. 从运行日志提取 Recovery Cases：

```powershell
uv run bua-cua extract-recovery-cases <run_id>
```

该命令会把一次运行中的 recovery 相关 JSONL 日志结构化为：

```text
runs/<run_id>/
  recovery_cases.json
```

`recovery_cases.json` 是日志的结构化视图，不是新的事实源，也不会自动写入 `knowledge.json`。后续必须通过显式 promote 才能沉淀为长期知识。

## Task Skill 编写要求

`index.ts` 必须导出：

```ts
export async function run(ctx: SkillContext, args: Record<string, unknown>): Promise<void>
```

脚本应直接使用原生 Playwright 和 Midscene API：

```ts
const { page, agent } = ctx;
await page.getByRole('button', { name: 'Search' }).click();
await agent.aiTap('点击当前业务步骤中的可见目标控件');
await agent.aiAssert('当前业务步骤的目标状态已经达成');
```

有 Playwright primary path 的业务步骤优先使用：

```ts
await ctx.withRecovery(
  '执行当前业务步骤',
  async () => {
    // Playwright primary path
  },
  {
    goal: '描述当前 step 的业务目标',
    hints: ['只处理当前 step，不重新规划整个任务'],
    allowedTools: ['viewportScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
    maxTurns: 6,
    risk: 'read_only',
  },
  async () => {
    // Midscene visual fallback after recovery fails or is unavailable
  },
  async () => {
    // verifier
  },
);
```

只有纯本地处理、纯断言或明确不允许 recovery 的高风险步骤，才使用 `ctx.withFallback`。

没有 Playwright primary path 的真实网站实验可以使用：

```ts
await ctx.recoverStep(
  '应用筛选条件',
  {
    goal: '在当前搜索结果页应用 Status 筛选',
    hints: ['只处理当前 step，不重新规划整个任务'],
    allowedTools: ['viewportScreenshot', 'fullPageScreenshot', 'jsProbe', 'inspectAt', 'domAct', 'clickAt'],
    maxTurns: 8,
    risk: 'read_only',
  },
  async () => {
    await ctx.agent.aiTap('应用筛选条件');
  },
  async () => {
    // verifier
  },
);
```

不要创建另一套动作 DSL。Runtime 的职责是执行容器，不是规划器。

API fast path 应作为可选加速路径，而不是替代 GUI 自动化。Skill 可以使用 `ctx.api.requestJson()`、`ctx.api.download()` 和 `ctx.api.verify()` 实现受约束的查询/下载逻辑；任何 API 参数错误、返回空、schema 变化或下载失败都应记录日志并回退到 `ctx.withRecovery` GUI 路径。

## 常用命令

```powershell
uv run bua-cua scaffold-input <task_name>
uv run bua-cua codegen <task_name> --url <start_url>
uv run bua-cua trace-codegen <task_name>
uv run bua-cua summarize-trace <task_name>
uv run bua-cua probe-api <task_name> --args .\skills\<task_name>\fixtures\input.example.json
uv run bua-cua probe-api <task_name> --args .\skills\<task_name>\fixtures\input.example.json --observe-gui
uv run bua-cua model-preflight --qwen
uv run bua-cua model-preflight --minimax
uv run bua-cua generate-skill <task_name>
uv run bua-cua validate-skill <task_name>
uv run bua-cua run-intent "<natural_language_intent>"
uv run bua-cua run-intent "<natural_language_intent>" --skill <task_name> --dry-run
uv run bua-cua extract-recovery-cases <run_id>
uv run bua-cua run-skill <task_name> --args .\skills\<task_name>\fixtures\input.example.json
uv run bua-cua run-skill <task_name> --args .\skills\<task_name>\fixtures\input.example.json --api-first
npm run typecheck
npm run smoke
```

## 当前限制

- 目前不把本仓库包装成 Codex Skill 或插件。
- 当前形态是 Git Repo 工具包，供 agent clone 后按本文档使用。
- MVP 不做 Evidence Card、Atomic Skill 提炼、全页面 DOM/AX state extractor 或复杂自动恢复。
- 真实业务 Task Skill 第一次执行前必须人工审查。
