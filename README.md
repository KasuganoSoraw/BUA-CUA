# BUA-CUA Toolkit

BUA-CUA Toolkit 是一个面向 agent 的网页任务自动化工具包，不是某个具体网页任务 Skill。

它提供两类能力：

- **生成 Task Skill**：基于自然语言任务描述和 Playwright codegen 录制脚本，生成经过人工审查后可执行的 Playwright + Midscene 混编脚本。
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
