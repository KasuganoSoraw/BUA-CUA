# BUA-CUA Toolkit

BUA-CUA Toolkit 是一个面向 agent 的网页任务自动化工具包，不是某个具体网页任务 Skill。

它提供两类能力：

- **生成 Task Skill**：基于自然语言任务描述和 Playwright codegen 录制脚本，生成经过人工审查后可执行的 Playwright + Midscene 混编脚本。
- **执行 Task Skill**：通过 Python CLI 和 Node/TS Runtime 加载、校验并执行已经生成的 Task Skill。

具体网页任务自动化能力称为 **Task Skill**，位于 `skills/<task_name>/`，例如 `login_to_nms` 或 `mock_query_eline_service_info`。

其他 agent 使用本仓库前，应先阅读 [AGENTS.md](AGENTS.md)。

## Quick Start

Install Node dependencies:

```powershell
npm install
```

Install and sync the Python environment:

```powershell
uv python install 3.12.10
uv sync
```

Run static checks:

```powershell
npm run typecheck
uv run bua-cua validate-skill mock_query_eline_service_info
```

Python is managed by `uv` and pinned to `3.12.10` through `.python-version` and
`pyproject.toml`. If `uv` is not installed, install it first from the official
Astral instructions, then run `uv python install 3.12.10`.

Run the mock skill in headed mode:

```powershell
uv run bua-cua run-skill mock_query_eline_service_info --args .\skills\mock_query_eline_service_info\fixtures\input.example.json
```

Create an input pack for a real recording:

```powershell
uv run bua-cua scaffold-input query_eline_service_info
```

Put the task description in `inputs/<task>/intent.md` and the Playwright
codegen output in `inputs/<task>/codegen.spec.ts`, then use
`prompts/task_skill_generation.md` to generate the reviewed Task Skill files.
