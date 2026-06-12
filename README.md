# BUA-CUA Toolkit

BUA-CUA Toolkit 是一个面向 agent 的网页任务自动化工具包，不是某个具体网页任务 Skill。

它提供两类能力：

- **生成 Task Skill**：基于自然语言任务描述、Playwright codegen 录制脚本和 Playwright trace 工程证据，生成经过人工审查后可执行的 Playwright + Midscene 混编脚本。
- **执行 Task Skill**：通过 Python CLI 和 Node/TS Runtime 加载、校验并执行已经生成的 Task Skill。

具体网页任务自动化能力称为 **Task Skill**，位于 `skills/<task_name>/`，例如 `login_to_nms` 或 `mock_query_eline_service_info`。

其他 agent 使用本仓库前，应先阅读 [AGENTS.md](AGENTS.md)。

## 环境准备

安装 Node 依赖：

```powershell
npm install
```

安装 Playwright Chromium：

```powershell
npx playwright install chromium
```

安装并同步 Python 环境：

```powershell
uv python install 3.12.10
uv sync
```

Python 由 `uv` 管理，并通过 `.python-version` 和 `pyproject.toml` 固定为 `3.12.10`。如果还没有安装 `uv`，可以先参考 Astral 官方安装方式，或使用清华源 bootstrap：

```powershell
python -m pip install uv -i https://pypi.tuna.tsinghua.edu.cn/simple --trusted-host pypi.tuna.tsinghua.edu.cn
```

如果浏览器能访问 GitHub 但 Git 命令经常超时，通常是浏览器走了本地代理而 Git 没有。可只给当前仓库配置代理，例如：

```powershell
git config http.proxy http://127.0.0.1:7897
git config https.proxy http://127.0.0.1:7897
```

### Recovery 模型配置

Step Recovery Agent 使用 OpenAI-compatible Chat Completions 协议。百炼/Qwen 默认配置示例：

```powershell
$env:MIDSCENE_MODEL_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:MIDSCENE_MODEL_API_KEY="<your-key>"
$env:MIDSCENE_MODEL_NAME="qwen3.7-plus"
$env:MIDSCENE_MODEL_FAMILY="qwen"
$env:BUA_CUA_RECOVERY_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:BUA_CUA_RECOVERY_API_KEY="<your-key>"
$env:BUA_CUA_RECOVERY_MODEL="qwen3.7-plus"
$env:BUA_CUA_RECOVERY_VISION="true"
$env:BUA_CUA_MIDSCENE_FALLBACK_TIMEOUT_MS="120000"
$env:BUA_CUA_GENERATION_TIMEOUT="1800"
```

手动文本预检：

```powershell
curl.exe "$env:BUA_CUA_RECOVERY_BASE_URL/chat/completions" `
  -H "Authorization: Bearer $env:BUA_CUA_RECOVERY_API_KEY" `
  -H "Content-Type: application/json" `
  -d "{\"model\":\"$env:BUA_CUA_RECOVERY_MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"回复 pong\"}]}"
```

不要把真实 API key 写入代码、README 或提交历史。

## 常用命令

### 检查项目

```powershell
uv run python --version
npm run typecheck
uv run bua-cua validate-skill mock_query_eline_service_info
```

### 初始化一个录制输入包

```powershell
uv run bua-cua scaffold-input arxiv-demo
```

该命令会创建：

```text
inputs/arxiv-demo/
  intent.md
  codegen.spec.ts
  steps.md
```

### 使用自然语言运行 Task Skill

```powershell
uv run bua-cua run-intent "<用自然语言描述要完成的网页任务>" --minimax
```

如果已经知道要使用哪个 Skill，可以固定 Skill，只让模型抽取本次运行参数：

```powershell
uv run bua-cua run-intent "<用自然语言描述该 Skill 的本次参数>" --skill <task_name> --dry-run --minimax
```

`run-intent` 会把解析结果写入 `runs/<timestamp>-intent/intent_resolution.json`，并把本次运行参数写入 `runs/<timestamp>-intent/args.json`。

### 从运行日志提取 Recovery Cases

```powershell
uv run bua-cua extract-recovery-cases <run_id>
```

该命令会把一次运行中的 recovery 相关 JSONL 日志结构化为 `runs/<run_id>/recovery_cases.json`，用于后续分析和人工 promote。

`intent.md` 写用户自然语言任务意图，`codegen.spec.ts` 放 Playwright codegen 录制脚本。

如果你已经准备开始官方 Playwright codegen 录制，通常不需要先手动执行 `scaffold-input`，可以直接使用下面的一键命令。

### 启动 Playwright codegen 录制

推荐使用 Toolkit 封装命令。它会自动创建 `inputs/<task>/`，并把官方 Playwright codegen 输出保存到 `inputs/<task>/codegen.spec.ts`：

```powershell
uv run bua-cua codegen arxiv-demo --url https://arxiv.org/
```

如果 `codegen.spec.ts` 已经存在且不是占位内容，该命令会先备份旧文件，再启动录制。若确认要直接覆盖：

```powershell
uv run bua-cua codegen arxiv-demo --url https://arxiv.org/ --overwrite
```

对容易触发安全验证的网站，可以指定真实浏览器 channel 和独立持久化 profile：

```powershell
uv run bua-cua codegen arxiv-demo --url https://arxiv.org/ --channel chrome --user-data-dir .\auth\codegen-chrome-profile
```

底层仍然使用官方 Playwright codegen。需要直接调用官方命令时，可以使用：

```powershell
npx playwright codegen --target=playwright-test -o .\inputs\arxiv-demo\codegen.spec.ts https://arxiv.org/
```

### 运行原始 codegen 录制脚本

当前项目是 ESM，直接跑 `.ts` 录制脚本时 Playwright 可能无法自动转译。可以先临时编译成 `.js` 再运行：

```powershell
if (Test-Path .playwright-tmp) { Remove-Item -Recurse -Force .playwright-tmp }

npx tsc .\inputs\arxiv-demo\codegen.spec.ts `
  --outDir .\.playwright-tmp `
  --module NodeNext `
  --moduleResolution NodeNext `
  --target ES2022 `
  --skipLibCheck

npx playwright test ".playwright-tmp/codegen.spec.js" --headed
```

无窗口运行：

```powershell
npx playwright test ".playwright-tmp/codegen.spec.js"
```

### 为 codegen 脚本生成 Playwright trace

`trace-codegen` 会运行 `inputs/<task>/codegen.spec.ts`，开启 Playwright trace，并把最新 `trace.zip` 保存到 `inputs/<task>/trace/trace.zip`。该命令会自动编译 TS 并生成临时 Playwright config，不需要手写 JS 脚本或复制文件到其他目录。
该 trace 用于补充 codegen 没有显式写出的 before/action/after 证据。
即使 codegen 脚本中途失败，只要 Playwright 产生了 trace，命令也会保留最新 `trace.zip` 供排查。

```powershell
uv run bua-cua trace-codegen arxiv-demo
```

有窗口运行：

```powershell
uv run bua-cua trace-codegen arxiv-demo --headed
```

查看 trace：

```powershell
npx playwright show-trace .\inputs\arxiv-demo\trace\trace.zip
```

### 提取 trace 工程证据

`summarize-trace` 不调用模型，只从 Playwright `trace.zip` 中提取可审计 facts，包括 action 顺序、locator、源码行、before/action/after snapshot id、精选截图、resolved HTML、日志、失败信息和 coverage。
同时它会从 trace network 中提取 `api_candidates.json`，记录查询、自动补全、下载等候选 API。API candidates 只是事实层候选，不代表已经验证可直接替代 GUI。

```powershell
uv run bua-cua summarize-trace arxiv-demo
```

输出：

```text
inputs/arxiv-demo/trace/
  trace_evidence.json
  api_candidates.json
  evidence-images/
```

`trace_evidence.json` 是后续让模型生成自然语言步骤、verifier 和 recovery hints 的事实输入。模型生成的语义描述必须引用其中的 action id / snapshot / frame evidence。
`api_candidates.json` 是生成 API fast path / `api_registry.json` 的事实输入。它不得包含 API key、cookie 或 authorization header；候选接口必须经过 probe 或运行时 verifier，失败时回退 GUI。

### 生成 Task Skill

生成 Task Skill 时，模型应同时读取：

```text
prompts/task_skill_generation.md
inputs/<task>/intent.md
inputs/<task>/codegen.spec.ts
inputs/<task>/trace/trace.zip           # 可选 Playwright trace evidence
inputs/<task>/trace/trace_evidence.json # 必须，工程事实层
```

可以使用 `.env` 中配置的 OpenAI-compatible 模型自动生成：

```powershell
uv run bua-cua generate-skill <task>
```

如果 `skills/<task>/` 已存在且确认要覆盖：

```powershell
uv run bua-cua generate-skill <task> --overwrite
```

并生成：

```text
skills/<task>/
  skill.json
  SKILL.md
  INFERRED_INTENT.md
  api_registry.json          # 可选，API fast path 候选/验证信息
  knowledge.json             # 可选，运行后沉淀的 GUI 知识，不包含 API fast path
  index.ts
  fixtures/input.example.json
  recordings/codegen.spec.ts
```

`INFERRED_INTENT.md` 必须说明它是 LLM 根据 `intent.md`、`codegen.spec.ts` 和 `trace_evidence.json` 推测生成的任务意图。它可作为后续执行与 step recovery 的参考，但不是工程事实层；事实层仍以 `trace_evidence.json` 为准。

`knowledge.json` 是运行学习层，用来承接显式 promote 后的 GUI option mapping、recovery case 和 selector hint。它不保存 API fast path；API 仍保留在独立 `api_registry.json`。

### 校验 Task Skill

```powershell
uv run bua-cua validate-skill arxiv-demo
npm run typecheck
```

### 执行 Task Skill

有浏览器窗口运行：

```powershell
uv run bua-cua run-skill arxiv-demo --args .\skills\arxiv-demo\fixtures\input.example.json
```

无窗口运行：

```powershell
uv run bua-cua run-skill arxiv-demo --args .\skills\arxiv-demo\fixtures\input.example.json --headless
```

执行日志会写入 `runs/`，失败截图会写入 `runs/artifacts/`。

### 自然语言执行 Task Skill

`run-intent` 是面向最终用户的入口。它会读取本地 `skills/*/skill.json`、`SKILL.md` 和 `INFERRED_INTENT.md`，调用模型选择合适的 Task Skill，并从自然语言中抽取参数，生成本次运行专用的 args JSON 后再调用 `run-skill`。

```powershell
uv run bua-cua run-intent "<用自然语言描述要完成的网页任务>" --minimax
```

如果已经知道要使用哪个 Skill，可以固定 Skill，只让模型抽取参数：

```powershell
uv run bua-cua run-intent "<用自然语言描述该 Skill 的本次参数>" --skill <task_name> --minimax
```

只解析意图和参数、不启动浏览器：

```powershell
uv run bua-cua run-intent "<用自然语言描述该 Skill 的本次参数>" --skill <task_name> --dry-run --minimax
```

解析产物会写入：

```text
runs/<timestamp>-intent/
  intent_resolution.json
  args.json
```

`fixtures/input.example.json` 只是录制样例和 schema 示例，不代表用户本次真实输入。`run-intent` 生成的 `runs/<timestamp>-intent/args.json` 才是本次运行实际使用的参数。

`run-intent --api-first` 会先完成自然语言意图解析，再把生成的 args 交给现有 `run-skill --api-first`。API fast path 仍然只是可选执行优化，不参与 skill 选择或参数抽取。

### 提取 Recovery Cases

`extract-recovery-cases` 会把一次运行中的 recovery 相关 JSONL 日志结构化为 `recovery_cases.json`。它不调用模型，也不写入 `knowledge.json`；后续显式 promote 时再决定哪些 case 可以沉淀。

```powershell
uv run bua-cua extract-recovery-cases <run_id>
```

默认输出：

```text
runs/<run_id>/
  recovery_cases.json
```

### API fast path

Task Skill 可以选择包含 `api_registry.json`，用于记录从 trace network 提取并经过审查的 API fast path 候选。API fast path 只适合查询、导出、下载等低风险任务；创建、提交、删除、重启或配置修改类 API 默认不能自动执行。

生成阶段只应把 API 路线沉淀为独立 `api_registry.json`，不要让 `probe-api` 自动修改 `index.ts`。`index.ts` 仍然是 GUI 主线脚本；API fast path 是后置优化层。

探测并固化 API fast path：

```powershell
uv run bua-cua probe-api <task> --args .\skills\<task>\fixtures\input.example.json
```

该命令会读取 `skill.json.apiRegistry` 指向的 `api_registry.json`，实际重放只读查询/下载请求，成功后把 candidate 升级为 `probed`，并写入：

```text
runs/<timestamp>-<task>-api-probe/api_probe.jsonl
```

如果需要借鉴 browser-harness 式的现场探索，可以让 probe 先执行 GUI 主线并监听同源 API/network 请求：

```powershell
uv run bua-cua probe-api <task> --args .\skills\<task>\fixtures\input.example.json --observe-gui
```

该模式会额外写入：

```text
runs/<timestamp>-<task>-api-probe/api_observation.json
```

`api_observation.json` 来自 live GUI 执行过程，包含同源 XHR/fetch/API/download 请求、query、状态码和小型 JSON/text/CSV 响应摘要。它是 API/option discovery 的证据，不是 approved fast path；`probe-api` 仍然不会修改 `index.ts`。

使用 API-first 执行：

```powershell
uv run bua-cua run-skill <task> --args .\skills\<task>\fixtures\input.example.json --api-first
```

`--api-first` 只执行 `probed` 或 `approved` 且 `risk: "read_only"` 的 fast path。API 参数缺失、schema 不匹配、返回为空、下载文件为空或 registry 未验证时，会记录原因并回退到原 `index.ts` GUI 主线。

推荐执行语义：

```text
try API fast path
  -> verify HTTP status / response schema / business fields / downloaded file
  -> success
catch
  -> log api_fast_path_failed
  -> run GUI path with ctx.withRecovery
```

Runtime 提供薄 helper，不负责规划 API：

```ts
const result = await ctx.api.requestJson('query studies', {
  url: 'https://example.com/api/search',
  query: { q: args.query },
});

ctx.api.verify(Array.isArray(result.items), 'API response must contain items');

const file = await ctx.api.download('download csv', {
  url: 'https://example.com/api/download',
  query: { format: 'csv' },
});

ctx.api.verify(file.bytes > 0, 'downloaded file must be non-empty');
```

`api_registry.json` 是 Skill 的独立产物，`skill.json` 通过 `apiRegistry` 字段引用它。API 路线不能散落成只有自然语言描述的隐式知识。

### Recovery-driven 真实网站 demo

`clinical_trials_download_recovery` 用于验证“没有 Playwright codegen，也可以由 `index.ts` 拆解业务步骤，再用 `ctx.recoverStep` 执行每个网页操作 step”。

校验：

```powershell
uv run bua-cua validate-skill clinical_trials_download_recovery
npm run typecheck
```

有浏览器窗口运行：

```powershell
uv run bua-cua run-skill clinical_trials_download_recovery --args .\skills\clinical_trials_download_recovery\fixtures\input.example.json
```

无窗口运行：

```powershell
uv run bua-cua run-skill clinical_trials_download_recovery --args .\skills\clinical_trials_download_recovery\fixtures\input.example.json --headless
```

该 demo 会访问 `https://clinicaltrials.gov/`，搜索临床研究关键词，应用招募状态筛选，并尝试下载 CSV。下载文件默认写入 `downloads/`。

`ctx.recoverStep` 与 `ctx.withRecovery` 的区别：

- `ctx.withRecovery`：有 Playwright primary。primary 抛错或 verifier 失败时都会启动 step recovery agent；recovery 后重新执行 verifier，仍失败再进入 Midscene fallback。
- `ctx.recoverStep`：没有 Playwright primary，当前 step 直接由 step recovery agent 执行，适合无 codegen 的 recovery-driven Task Skill。

由 Playwright codegen 派生的普通 Task Skill，网页操作步骤也应默认使用 `ctx.withRecovery`，链路为 `Playwright primary -> verifier -> step recovery agent/CDP -> verifier -> Midscene fallback -> verifier`。`ctx.withFallback` 只适合纯本地处理、纯断言或明确不允许 recovery 的高风险步骤。

### 模型 provider 切换

`--qwen` 和 `--minimax` 会从 `.env` 中读取对应 provider 配置，用于模型预检、Task Skill 生成和运行时 recovery。Task Skill 脚本本身不应硬编码 provider 或 API key。

```powershell
uv run bua-cua model-preflight --qwen
uv run bua-cua model-preflight --minimax
uv run bua-cua generate-skill <task> --qwen --overwrite
uv run bua-cua generate-skill <task> --minimax --overwrite
uv run bua-cua run-skill <task> --args .\skills\<task>\fixtures\input.example.json --qwen
uv run bua-cua run-skill <task> --args .\skills\<task>\fixtures\input.example.json --minimax
```

MiniMax 使用火山方舟 OpenAI-compatible endpoint，`.env` 示例：

```text
BUA_CUA_MINIMAX_BASE_URL=https://ark.cn-beijing.volces.com/api/coding/v3
BUA_CUA_MINIMAX_API_KEY=<your-key>
BUA_CUA_MINIMAX_MODEL=minimax-m3
```

使用 `--minimax` 时，Toolkit 会在 Chat Completions 请求中自动发送 `thinking: { "type": "disabled" }`，避免 MiniMax-M3 默认进入思考模式并消耗额外 token。

真实 API key 只放本地 `.env`，不要提交。
