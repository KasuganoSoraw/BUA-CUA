# BUA-CUA Toolkit Agent 使用指引

本仓库是 **BUA-CUA Toolkit**，不是某个具体网页任务 Skill。其他 agent clone 本仓库后，可以使用它完成两件事：

- **生成 Task Skill**：根据 `intent.md` 和 Playwright `codegen.spec.ts`，生成 `skill.json`、`SKILL.md`、`index.ts`。
- **执行 Task Skill**：通过 `uv run bua-cua run-skill ...` 执行已经生成并经过人工审查的 Task Skill。

enhanced recorder 是生成 Task Skill 的输入增强工具，用于补充脚本轨迹之外的 raw evidence。

## 概念边界

- **BUA-CUA Toolkit**：本仓库整体，包含 prompt、schema、Python CLI、Node/TS Runtime、示例 Task Skill 和安装指引。
- **Task Skill Generator Guidance**：主要是 `prompts/task_skill_generation.md`，用于指导 agent 生成 Task Skill。它不是自动 LLM 调用器。
- **Enhanced Recorder**：由 `uv run bua-cua record ...` 调用，用于补充 Playwright codegen 没有记录的 raw evidence，例如截图、坐标、局部 DOM evidence、selector 候选和 before/after 状态。
- **Task Skill Runner**：由 `uv run bua-cua run-skill ...` 调用，负责加载、校验、运行 Task Skill。
- **Task Skill**：位于 `skills/<task_name>/` 的具体网页任务级混编脚本，使用 Playwright + Midscene，并通过 `ctx.withFallback` 做局部 fallback 和日志。
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

2. 填写自然语言任务描述：

```text
inputs/<task_name>/intent.md
```

3. 粘贴 Playwright codegen 录制脚本：

```text
inputs/<task_name>/codegen.spec.ts
```

4. 可选执行 enhanced recorder 证据录制：

```powershell
uv run bua-cua record <task_name> --url <start_url>
```

如需降低安全验证触发概率，可使用独立持久化 profile 和真实浏览器 channel：

```powershell
uv run bua-cua record <task_name> --url <start_url> --channel chrome --user-data-dir .\auth\recorder-chrome-profile
```

不要直接复用日常个人浏览器 profile。建议使用项目内独立目录积累 cookie/session。

生成目录：

```text
inputs/<task_name>/recording/
  recording.json
  actions/action-001.json
  screenshots/action-001-before.png
  screenshots/action-001-after.png
  screenshots/action-001-annotated.png
```

对于带有点击坐标的动作，recorder 会额外生成 `*-annotated.png`。该图片基于操作前截图生成，其中的红色十字、圆圈和中心圆点是 recorder 后处理添加的，用于提示人类操作位置，不是网页自身 UI。agent 使用截图时必须明确这一点，不要把标记当作页面元素。

第一版 enhanced recorder 不替代官方 Playwright codegen，可能需要单独录制一次。若两次录制存在差异，生成 Task Skill 时以 `codegen.spec.ts` 的业务顺序为准，`recording/` 只作为 verifier、locator 和 step recovery 的辅助证据。

5. 可选为 codegen 脚本生成 Playwright trace：

```powershell
uv run bua-cua trace-codegen <task_name>
```

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

6. 可选提取 trace 工程证据：

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

7. 可选填写人工步骤说明：

```text
inputs/<task_name>/steps.md
```

8. 使用 `prompts/task_skill_generation.md` 指导 agent 生成 Task Skill。

生成目标目录：

```text
skills/<task_name>/
  skill.json
  SKILL.md
  index.ts
  fixtures/input.example.json
  recordings/codegen.spec.ts
```

9. 人工审查生成结果。

重点检查：

- 是否保留了 codegen 中的人类业务顺序。
- 是否按页面状态转换切分 step。
- 每个关键业务 step 是否有 Playwright primary、Midscene fallback 和 verifier。
- 是否识别并替换了明显不稳定 locator，例如动态 id、长随机 class、深层 CSS 链、过度 `nth()`。
- 是否只参数化业务数据，例如 NE 名称、搜索关键字、业务对象名、tab、字段、筛选值。
- 是否没有硬编码模型密钥。
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

## Task Skill 编写要求

`index.ts` 必须导出：

```ts
export async function run(ctx: SkillContext, args: Record<string, unknown>): Promise<void>
```

脚本应直接使用原生 Playwright 和 Midscene API：

```ts
const { page, agent } = ctx;
await page.getByRole('button', { name: 'Search' }).click();
await agent.aiTap('点击拓扑画布中的目标 NE 节点');
await agent.aiAssert('E-Line Service 页面已经打开');
```

业务步骤优先使用：

```ts
await ctx.withFallback(
  '搜索目标 NE',
  async () => {
    // Playwright primary path
  },
  async () => {
    // Midscene visual fallback
  },
  async () => {
    // verifier
  },
);
```

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

## 常用命令

```powershell
uv run bua-cua scaffold-input <task_name>
uv run bua-cua record <task_name> --url <start_url>
uv run bua-cua trace-codegen <task_name>
uv run bua-cua summarize-trace <task_name>
uv run bua-cua validate-skill <task_name>
uv run bua-cua run-skill <task_name> --args .\skills\<task_name>\fixtures\input.example.json
npm run typecheck
npm run smoke
```

## 当前限制

- 目前不把本仓库包装成 Codex Skill 或插件。
- 当前形态是 Git Repo 工具包，供 agent clone 后按本文档使用。
- MVP 不做 Evidence Card、Atomic Skill 提炼、全页面 DOM/AX state extractor 或复杂自动恢复。
- 真实业务 Task Skill 第一次执行前必须人工审查。
