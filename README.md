# BUA-CUA Toolkit

BUA-CUA Toolkit 是一个面向 agent 的网页任务自动化工具包，不是某个具体网页任务 Skill。

它提供两类能力：

- **生成 Task Skill**：基于自然语言任务描述、Playwright codegen 录制脚本和可选 enhanced recorder 证据，生成经过人工审查后可执行的 Playwright + Midscene 混编脚本。
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
$env:MIDSCENE_MODEL_NAME="qwen3.6-plus"
$env:MIDSCENE_MODEL_FAMILY="qwen3.6"
$env:BUA_CUA_RECOVERY_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"
$env:BUA_CUA_RECOVERY_API_KEY="<your-key>"
$env:BUA_CUA_RECOVERY_MODEL="qwen3.6-plus"
$env:BUA_CUA_RECOVERY_VISION="true"
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

`intent.md` 写用户自然语言任务意图，`codegen.spec.ts` 放 Playwright codegen 录制脚本。

### 启动 Playwright codegen 录制

录制到指定输入包：

```powershell
npx playwright codegen --target=typescript -o .\inputs\arxiv-demo\codegen.spec.ts
```

从指定网址开始录制：

```powershell
npx playwright codegen --target=typescript -o .\inputs\arxiv-demo\codegen.spec.ts https://arxiv.org/
```

### 启动 enhanced recorder 证据录制

enhanced recorder 不替代官方 Playwright codegen。第一版它只记录 raw evidence，例如 viewport 截图、点击坐标、局部 DOM evidence、selector 候选和 before/after 状态。

```powershell
uv run bua-cua record arxiv-demo --url https://arxiv.org/
```

输出目录：

```text
inputs/arxiv-demo/recording/
  recording.json
  actions/action-001.json
  screenshots/action-001-before.png
  screenshots/action-001-after.png
  screenshots/action-001-annotated.png
```

对于带有点击坐标的动作，recorder 会额外生成 `*-annotated.png`。该图片中的品红色圆圈和光标标记是 recorder 后处理添加的，用于提示人类操作位置，不是网页自身 UI。

当前第一版可能需要录制两次：一次使用官方 `npx playwright codegen` 生成脚本轨迹，一次使用 `uv run bua-cua record ...` 生成证据轨迹。若两次录制存在细微差异，生成 Task Skill 时以 `codegen.spec.ts` 的业务顺序为准，`recording/` 仅作为 verifier、locator 和 recovery 的辅助证据。

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

### 生成 Task Skill

当前 MVP 没有自动 LLM 生成命令。生成 Task Skill 时，让 agent 同时读取：

```text
prompts/task_skill_generation.md
inputs/<task>/intent.md
inputs/<task>/codegen.spec.ts
inputs/<task>/recording/recording.json  # 可选 raw evidence
```

并生成：

```text
skills/<task>/
  skill.json
  SKILL.md
  index.ts
  fixtures/input.example.json
  recordings/codegen.spec.ts
```

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

- `ctx.withRecovery`：有 Playwright primary，失败后才启动 step recovery agent。
- `ctx.recoverStep`：没有 Playwright primary，当前 step 直接由 step recovery agent 执行，适合无 codegen 的 recovery-driven Task Skill。
