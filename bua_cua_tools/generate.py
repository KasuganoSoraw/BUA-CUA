"""Task Skill generation via an OpenAI-compatible chat model."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "qwen3.7-plus"
METADATA_GENERATED_FILES = {
    "skill.json",
    "SKILL.md",
    "INFERRED_INTENT.md",
    "fixtures/input.example.json",
}
OPTIONAL_METADATA_GENERATED_FILES = {"api_registry.json"}
INDEX_GENERATED_FILES = {"index.ts"}
OPTIONAL_GENERATED_FILES = OPTIONAL_METADATA_GENERATED_FILES
REQUIRED_GENERATED_FILES = METADATA_GENERATED_FILES | INDEX_GENERATED_FILES
RISK_VALUES = {"read_only", "write_review_required", "destructive_review_required"}
RECOVERY_TOOL_NAMES = {
    "screenshot",
    "viewportScreenshot",
    "fullPageScreenshot",
    "jsProbe",
    "inspectAt",
    "domAct",
    "clickAt",
    "cdp",
}


@dataclass(frozen=True)
class GenerationInputs:
    task: str
    generation_guidance: str
    user_intent: str
    user_steps: str
    codegen_script: str
    trace_evidence_json: str
    api_candidates_json: str


def load_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def env_value(dotenv: dict[str, str], *names: str, default: str = "") -> str:
    for name in names:
        value = os.environ.get(name) or dotenv.get(name)
        if value:
            return value
    return default


def is_placeholder(text: str) -> bool:
    stripped = text.strip()
    return (
        not stripped
        or "Describe the business task and its parameters here" in stripped
        or "Add clarifying business steps if needed" in stripped
    )


def read_optional(path: Path) -> str:
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace")


def truncate_text(value: Any, max_chars: int = 900) -> Any:
    if not isinstance(value, str):
        return value
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 20].rstrip() + "...[truncated]"


def compact_params(params: Any) -> Any:
    if not isinstance(params, dict):
        return params
    kept: dict[str, Any] = {}
    for key in ("selector", "url", "text", "value", "timeout", "waitUntil"):
        if key in params:
            kept[key] = truncate_text(params[key], 500)
    return kept


def compact_logs(logs: Any, max_lines: int = 10) -> list[str]:
    if not isinstance(logs, list):
        return []
    keywords = (
        "waiting for ",
        "locator resolved",
        "strict mode violation",
        "element is visible",
        "element is not visible",
        "scrolling into view",
        "done scrolling",
        "click action done",
        "fill(",
        "select option",
        "navigating to ",
        "navigations have finished",
        "download",
        "Timeout",
        "Error",
    )
    selected: list[str] = []
    for item in logs:
        if not isinstance(item, str):
            continue
        if any(keyword in item for keyword in keywords):
            selected.append(truncate_text(item, 500))
        if len(selected) >= max_lines:
            break
    if not selected and logs:
        selected = [truncate_text(str(logs[0]), 500)]
    return selected


def compact_selected_frames(frames: Any) -> Any:
    if not isinstance(frames, dict):
        return frames
    compacted: dict[str, Any] = {}
    for name in ("before", "action", "after"):
        frame = frames.get(name)
        if not isinstance(frame, dict):
            continue
        compacted[name] = {
            "url": frame.get("url"),
            "title": frame.get("title"),
            "screenshot": frame.get("screenshot"),
        }
    return compacted


def compact_element_evidence(items: Any, max_items: int = 6) -> list[Any]:
    if not isinstance(items, list):
        return []
    compacted = []
    for item in items[:max_items]:
        if not isinstance(item, dict):
            compacted.append(item)
            continue
        compacted.append(
            {
                key: truncate_text(item.get(key), 300)
                for key in (
                    "id",
                    "type",
                    "name",
                    "ariaLabel",
                    "labelText",
                    "text",
                    "value",
                    "checked",
                    "visible",
                    "ariaHidden",
                    "bboxNonZero",
                    "inViewport",
                    "selector",
                    "className",
                )
                if key in item
            }
        )
    return compacted


def compact_state(state: Any) -> Any:
    if not isinstance(state, dict):
        return state
    delta = state.get("delta") if isinstance(state.get("delta"), dict) else {}
    query_params = delta.get("queryParams") if isinstance(delta.get("queryParams"), dict) else {}
    return {
        "url": {
            "before": state.get("beforeUrl"),
            "after": state.get("afterUrl"),
            "changed": state.get("urlChanged"),
        },
        "queryParams": {
            "changed": query_params.get("changed", [])[:12],
            "added": query_params.get("added", [])[:12],
            "removed": query_params.get("removed", [])[:12],
        },
        "checkedChanges": compact_element_evidence(delta.get("checkedChanges"), 10),
        "valueChanges": compact_element_evidence(delta.get("valueChanges"), 8),
        "dialogLikeAdded": compact_element_evidence(delta.get("dialogLikeAdded"), 8),
        "textAddedSample": [truncate_text(text, 160) for text in delta.get("textAddedSample", [])[:10]]
        if isinstance(delta.get("textAddedSample"), list)
        else [],
        "textRemovedSample": [truncate_text(text, 160) for text in delta.get("textRemovedSample", [])[:6]]
        if isinstance(delta.get("textRemovedSample"), list)
        else [],
    }


def compact_verifier_candidates(candidates: Any, max_candidates: int = 8) -> list[Any]:
    if not isinstance(candidates, list):
        return []
    compacted = []
    for candidate in candidates[:max_candidates]:
        if not isinstance(candidate, dict):
            compacted.append(candidate)
            continue
        evidence = candidate.get("evidence")
        compacted.append(
            {
                "kind": candidate.get("kind"),
                "target": truncate_text(candidate.get("target"), 300),
                "recommendedVerifier": truncate_text(candidate.get("recommendedVerifier"), 500),
                "source": candidate.get("source"),
                "evidence": compact_element_evidence(evidence, 8)
                if isinstance(evidence, list)
                else truncate_text(evidence, 700),
            }
        )
    return compacted


def compact_trace_evidence(trace_evidence: dict[str, Any]) -> dict[str, Any]:
    actions = []
    for action in trace_evidence.get("actions", []):
        if not isinstance(action, dict):
            continue
        actions.append(
            {
                "id": action.get("id"),
                "codegenActionIndex": action.get("codegenActionIndex"),
                "source": action.get("source"),
                "method": action.get("method"),
                "params": compact_params(action.get("params")),
                "inputPoint": action.get("inputPoint"),
                "status": action.get("status"),
                "selectedFrames": compact_selected_frames(action.get("selectedFrames")),
                "state": compact_state(action.get("state")),
                "verifierCandidates": compact_verifier_candidates(action.get("verifierCandidates")),
                "resolvedHtml": truncate_text(action.get("resolvedHtml"), 900),
                "logs": compact_logs(action.get("logs")),
                "error": truncate_text(action.get("error"), 900),
            }
        )
    return {
        "schemaVersion": trace_evidence.get("schemaVersion"),
        "taskName": trace_evidence.get("taskName"),
        "traceStatus": trace_evidence.get("traceStatus"),
        "coverage": trace_evidence.get("coverage"),
        "actions": actions,
        "failure": trace_evidence.get("failure"),
        "notes": trace_evidence.get("notes"),
    }


def compact_api_candidates(api_candidates: dict[str, Any]) -> dict[str, Any]:
    compacted = []
    for candidate in api_candidates.get("candidates", []):
        if not isinstance(candidate, dict):
            continue
        response = candidate.get("response") if isinstance(candidate.get("response"), dict) else {}
        json_summary = response.get("jsonSummary") if isinstance(response, dict) else None
        if isinstance(json_summary, dict) and isinstance(json_summary.get("aggFilterGroups"), list):
            json_summary = {
                **json_summary,
                "aggFilterGroups": json_summary["aggFilterGroups"][:12],
            }
        compacted.append(
            {
                "id": candidate.get("id"),
                "kind": candidate.get("kind"),
                "status": candidate.get("status"),
                "method": candidate.get("method"),
                "url": candidate.get("url"),
                "query": candidate.get("query"),
                "response": {
                    "status": response.get("status") if isinstance(response, dict) else None,
                    "mimeType": response.get("mimeType") if isinstance(response, dict) else None,
                    "size": response.get("size") if isinstance(response, dict) else None,
                    "jsonSummary": json_summary,
                },
                "evidence": candidate.get("evidence"),
                "notes": candidate.get("notes"),
            }
        )
    return {
        "schemaVersion": api_candidates.get("schemaVersion"),
        "status": api_candidates.get("status"),
        "candidates": compacted[:30],
        "notes": api_candidates.get("notes"),
    }


def load_generation_inputs(task: str) -> GenerationInputs:
    input_dir = ROOT / "inputs" / task
    codegen_path = input_dir / "codegen.spec.ts"
    trace_evidence_path = input_dir / "trace" / "trace_evidence.json"
    api_candidates_path = input_dir / "trace" / "api_candidates.json"
    prompt_path = ROOT / "prompts" / "task_skill_generation.md"

    if not codegen_path.exists():
        raise FileNotFoundError(f"Missing codegen script: {codegen_path}")
    if not trace_evidence_path.exists():
        raise FileNotFoundError(f"Missing trace evidence: {trace_evidence_path}")

    intent = read_optional(input_dir / "intent.md")
    steps = read_optional(input_dir / "steps.md")
    trace_evidence = compact_trace_evidence(json.loads(trace_evidence_path.read_text(encoding="utf-8")))
    api_candidates_json = ""
    if api_candidates_path.exists():
        api_candidates = compact_api_candidates(json.loads(api_candidates_path.read_text(encoding="utf-8")))
        api_candidates_json = json.dumps(api_candidates, ensure_ascii=False, indent=2)
    user_intent = intent if not is_placeholder(intent) else "用户未提供真实自然语言意图，请根据 codegen 和 trace_evidence 推断任务目标。"
    user_steps = steps if not is_placeholder(steps) else "用户未提供人工步骤说明。"
    return GenerationInputs(
        task=task,
        generation_guidance=prompt_path.read_text(encoding="utf-8"),
        user_intent=user_intent,
        user_steps=user_steps,
        codegen_script=codegen_path.read_text(encoding="utf-8"),
        trace_evidence_json=json.dumps(trace_evidence, ensure_ascii=False, indent=2),
        api_candidates_json=api_candidates_json or "未提供 api_candidates.json。",
    )


def common_system_prompt() -> str:
    return (
        "你是 BUA-CUA Toolkit 的 Task Skill 生成模型。"
        "你必须严格根据输入事实生成文件内容，不得编造没有证据的页面状态。"
        "输出必须是一个 JSON 对象，格式为 {\"files\": {\"path\": \"content\"}}，不要输出 Markdown 代码围栏。"
        "面向人和模型的说明使用中文；代码 API、路径、字段名保持英文。"
    )


def common_generation_context(inputs: GenerationInputs) -> str:
    return f"""
下面是 Task Skill 生成规范：
{inputs.generation_guidance}

任务名：`{inputs.task}`

用户自然语言意图：
```md
{inputs.user_intent}
```

用户人工步骤说明：
```md
{inputs.user_steps}
```

Playwright codegen 脚本：
```ts
{inputs.codegen_script}
```

工程提取的 trace_evidence.json：
```json
{inputs.trace_evidence_json}
```

工程提取的 api_candidates.json：
```json
{inputs.api_candidates_json}
```
"""


def build_metadata_generation_prompt(inputs: GenerationInputs) -> list[dict[str, str]]:
    user_prompt = f"""
{common_generation_context(inputs)}

请先只生成 Task Skill 的元数据和说明文件，不要生成 `index.ts`。

输出约束：
- 只能输出 JSON 对象，不能输出解释性文字。
- JSON 顶层必须是 `files`。
- `files` 必须且只能包含这些路径：
  - skill.json
  - SKILL.md
  - INFERRED_INTENT.md
  - fixtures/input.example.json
  - api_registry.json（可选，仅当 api_candidates.json 中存在对本任务有帮助的 read/download API candidate 时生成）
- `skill.json.name` 必须使用 `{inputs.task}`。
- `skill.json.entry` 必须是 `index.ts`。
- `skill.json.inferredIntent` 必须是 `INFERRED_INTENT.md`。
- 如果生成 `api_registry.json`，`skill.json.apiRegistry` 必须是 `api_registry.json`。
- `api_registry.json` 只能记录 candidate 或 verified fast path 的元数据，不得包含 API key、cookie、authorization header 或本地隐私信息。
- `INFERRED_INTENT.md` 必须明确说明：这是模型根据 codegen 与 trace_evidence 推断的人类任务意图，不是用户手写原始意图。
- 参数只能来自自然语言可表达、或能在页面中通过稳定文案/状态定位的业务参数；不要把 DOM id、radio id、checkbox id、内部 hit id 设计成用户输入参数。
- 不要生成 `recordings/codegen.spec.ts`，该文件由工具复制原始 codegen。
"""
    return [
        {"role": "system", "content": common_system_prompt()},
        {"role": "user", "content": user_prompt},
    ]


def build_index_generation_prompt(inputs: GenerationInputs, metadata_files: dict[str, str]) -> list[dict[str, str]]:
    metadata_json = json.dumps(metadata_files, ensure_ascii=False, indent=2)
    user_prompt = f"""
{common_generation_context(inputs)}

下面是第一阶段已经生成并通过本地校验的元数据文件，请根据它们生成 `index.ts`：
```json
{metadata_json}
```

这些第一阶段文件是本轮生成前对任务的全局理解：
- `INFERRED_INTENT.md` 记录了模型根据 intent、codegen 和 trace_evidence 推断出的任务目标、业务步骤、参数含义、证据引用和不确定点。
- `SKILL.md` 记录了面向使用者的任务说明、执行大纲、verifier 策略和风险提示。
- `skill.json` 与 `fixtures/input.example.json` 定义了本次脚本必须使用的参数契约。

生成 `index.ts` 时必须优先保持与这些文件一致，不要重新发明一套步骤、参数或业务目标。若第一阶段理解与 codegen / trace_evidence 的工程事实冲突，以 codegen / trace_evidence 为准，但不能无理由偏离第一阶段已经归纳出的业务流程。`fixtures/input.example.json` 中的参数必须直接驱动脚本，不要在 `index.ts` 中引入新的用户参数。

请只生成 Task Skill 入口脚本 `index.ts`。

输出约束：
- 只能输出 JSON 对象，不能输出解释性文字。
- JSON 顶层必须是 `files`。
- `files` 必须且只能包含 `index.ts`。
- `index.ts` 必须导出 `run(ctx: SkillContext, args: Record<string, unknown>): Promise<void>`。
- `index.ts` 必须可被当前项目 `npm run typecheck` 检查。
- 网页业务操作 step 应优先使用 `ctx.withRecovery`；无稳定 primary path 时才使用 `ctx.recoverStep`。
- 如果第一阶段生成了 `api_registry.json`，第二阶段可以参考它理解可选 API 路线，但不要把 API-first 逻辑写进 `index.ts`。`index.ts` 必须保持 GUI 主链路；API fast path 由 `probe-api` 固化，并由 `run-skill --api-first` 在运行时优先尝试，失败后回退 GUI。
- verifier 必须按业务 step 判断状态达成，不要把下一步要点击的按钮可见性当作当前 step 的 verifier。
- 如果 trace logs 显示下一步 click 会自动 `scrolling into view if needed`，不要在前一步强行 `toBeVisible()` 验证该按钮。
- 下载类 step 应以 Playwright download event 和非空文件作为最终 verifier。
- Midscene fallback 应使用 `ctx.agent`，不要在 fallback 中硬编码真实 API key。
"""
    return [
        {"role": "system", "content": common_system_prompt()},
        {"role": "user", "content": user_prompt},
    ]


def build_generation_prompt(task: str) -> list[dict[str, str]]:
    """Build the legacy one-shot prompt for diagnostics."""
    inputs = load_generation_inputs(task)
    user_prompt = f"""
{common_generation_context(inputs)}

请为任务 `{task}` 一次性生成 Task Skill 文件。

输出约束：
- 只能输出 JSON 对象，不能输出解释性文字。
- JSON 顶层必须是 `files`。
- `files` 必须且只能包含这些路径：
  - skill.json
  - SKILL.md
  - INFERRED_INTENT.md
  - index.ts
  - fixtures/input.example.json
- `skill.json.name` 必须使用 `{task}`。
- `skill.json.inferredIntent` 必须是 `INFERRED_INTENT.md`。
- TypeScript 代码必须可被当前项目 `npm run typecheck` 检查。
- 生成内容必须使用中文说明；代码 API、路径、字段名保持英文。
- 不要生成 `recordings/codegen.spec.ts`，该文件由工具复制原始 codegen。
"""
    return [
        {"role": "system", "content": common_system_prompt()},
        {"role": "user", "content": user_prompt},
    ]


def call_chat_completion(
    messages: list[dict[str, str]],
    model: str,
    base_url: str,
    api_key: str,
    timeout: int,
    *,
    json_mode: bool = True,
    disable_thinking: bool = False,
) -> str:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    if disable_thinking:
        payload["thinking"] = {"type": "disabled"}
    request = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            response_payload = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Generation model request failed: HTTP {exc.code} {body}") from exc

    message = response_payload.get("choices", [{}])[0].get("message", {})
    content = message.get("content")
    if not isinstance(content, str) or not content.strip():
        raise RuntimeError(f"Generation model returned no content: {response_payload}")
    return content


def validate_metadata_files(files: dict[str, str]) -> None:
    manifest = json.loads(files["skill.json"])
    if manifest.get("name") is None:
        raise ValueError("Generated skill.json must include `name`")
    if manifest.get("type") != "task":
        raise ValueError("Generated skill.json type must be `task`")
    if manifest.get("risk") not in RISK_VALUES:
        raise ValueError(
            "Generated skill.json risk must be one of "
            "read_only, write_review_required, destructive_review_required"
        )
    if manifest.get("entry") != "index.ts":
        raise ValueError("Generated skill.json entry must be `index.ts`")
    if manifest.get("inferredIntent") != "INFERRED_INTENT.md":
        raise ValueError("Generated skill.json inferredIntent must be `INFERRED_INTENT.md`")
    api_registry = manifest.get("apiRegistry")
    if "api_registry.json" in files:
        if api_registry != "api_registry.json":
            raise ValueError("Generated skill.json apiRegistry must be `api_registry.json` when api_registry.json is generated")
        registry = json.loads(files["api_registry.json"])
        if not isinstance(registry, dict):
            raise ValueError("Generated api_registry.json must be a JSON object")
        if "apiKey" in json.dumps(registry, ensure_ascii=False).lower() or "authorization" in json.dumps(registry, ensure_ascii=False).lower():
            raise ValueError("Generated api_registry.json must not include API keys or authorization headers")
    elif api_registry is not None:
        raise ValueError("Generated skill.json must not reference apiRegistry unless api_registry.json is generated")
    fixture = json.loads(files["fixtures/input.example.json"])
    if not isinstance(fixture, dict):
        raise ValueError("Generated fixtures/input.example.json must be a JSON object")


def validate_index_file(files: dict[str, str]) -> None:
    index_ts = files["index.ts"]
    if "withRecovery(" not in index_ts and "recoverStep(" not in index_ts:
        raise ValueError("Generated index.ts must use ctx.withRecovery or ctx.recoverStep for webpage operation steps")
    for match in re.finditer(r"allowedTools\s*:\s*\[([^\]]*)\]", index_ts, re.DOTALL):
        for tool in re.findall(r"['\"]([^'\"]+)['\"]", match.group(1)):
            if tool not in RECOVERY_TOOL_NAMES:
                raise ValueError(
                    f"Generated index.ts uses unsupported recovery tool `{tool}`. "
                    f"Allowed tools: {', '.join(sorted(RECOVERY_TOOL_NAMES))}"
                )
    if re.search(r"getByText\([^)]*selected[^)]*\)\)\.toBeVisible", index_ts):
        raise ValueError(
            "Generated verifier must not use page.getByText('* selected').toBeVisible(); "
            "it can match hidden download radio labels. Verify checked state, visible result area, or download event instead."
        )
    if re.search(r"getByRole\(\s*['\"](?:radio|checkbox)['\"][\s\S]{0,120}\)\.click\(", index_ts):
        raise ValueError(
            "Generated index.ts must not mechanically click getByRole('radio'|'checkbox') for custom filter controls. "
            "If codegen/trace clicked visible text or label, click the visible business label/text/container instead, "
            "for example scoped getByText(...).click() or locator('label').filter({ hasText: ... }).click(). "
            "The input role may be off-screen while its label is the actual clickable target."
        )


def validate_generated_files(files: dict[str, str]) -> None:
    validate_metadata_files(files)
    validate_index_file({"index.ts": files["index.ts"]})


def parse_file_generation(content: str, required_files: set[str], optional_files: set[str] | None = None) -> dict[str, str]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    payload = json.loads(text)
    files = payload.get("files")
    if not isinstance(files, dict):
        raise ValueError("Generation output must contain object field `files`")
    optional_files = optional_files or set()
    unknown = set(files) - required_files - optional_files
    missing = required_files - set(files)
    if unknown or missing:
        raise ValueError(f"Invalid generated file set. missing={sorted(missing)} unknown={sorted(unknown)}")
    normalized: dict[str, str] = {}
    for relative_path, content_value in files.items():
        if not isinstance(content_value, str):
            raise ValueError(f"Generated file content must be string: {relative_path}")
        normalized[relative_path] = content_value
    return normalized


def parse_generation(content: str) -> dict[str, str]:
    files = parse_file_generation(content, REQUIRED_GENERATED_FILES, OPTIONAL_GENERATED_FILES)
    validate_generated_files(files)
    return files


def generate_file_set(
    label: str,
    messages: list[dict[str, str]],
    required_files: set[str],
    validator: Callable[[dict[str, str]], None],
    model: str,
    base_url: str,
    api_key: str,
    timeout: int,
    *,
    optional_files: set[str] | None = None,
    json_mode: bool = True,
    disable_thinking: bool = False,
) -> dict[str, str]:
    last_error: Exception | None = None
    for attempt in range(1, 3):
        content = call_chat_completion(
            messages,
            model,
            base_url,
            api_key,
            timeout,
            optional_files=OPTIONAL_METADATA_GENERATED_FILES,
            json_mode=json_mode,
            disable_thinking=disable_thinking,
        )
        try:
            files = parse_file_generation(content, required_files, optional_files)
            validator(files)
            return files
        except Exception as exc:
            last_error = exc
            messages.append({"role": "assistant", "content": content})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        f"上一轮生成的 {label} 不符合 BUA-CUA 文件契约。"
                        "请只返回修正后的 JSON，不要输出解释性文字。"
                        f"错误信息：{exc}"
                    ),
                }
            )
            print(f"{label} generation attempt {attempt} failed validation: {exc}", file=sys.stderr)
    raise RuntimeError(f"{label} generation failed validation: {last_error}")


def write_generated_skill(task: str, files: dict[str, str], overwrite: bool) -> Path:
    skill_dir = ROOT / "skills" / task
    if skill_dir.exists() and any(skill_dir.iterdir()) and not overwrite:
        raise FileExistsError(f"Skill directory already exists and is not empty: {skill_dir}")

    skill_dir.mkdir(parents=True, exist_ok=True)
    for relative_path, content in files.items():
        target = (skill_dir / relative_path).resolve()
        if not str(target).startswith(str(skill_dir.resolve())):
            raise ValueError(f"Refusing to write outside skill dir: {relative_path}")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content.rstrip() + "\n", encoding="utf-8")

    recordings_dir = skill_dir / "recordings"
    recordings_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(ROOT / "inputs" / task / "codegen.spec.ts", recordings_dir / "codegen.spec.ts")
    return skill_dir


def command_generate_skill(args: argparse.Namespace) -> int:
    dotenv = load_dotenv(ROOT / ".env")
    base_url = env_value(dotenv, "BUA_CUA_GENERATION_BASE_URL", "BUA_CUA_RECOVERY_BASE_URL", "MIDSCENE_MODEL_BASE_URL")
    api_key = env_value(dotenv, "BUA_CUA_GENERATION_API_KEY", "BUA_CUA_RECOVERY_API_KEY", "MIDSCENE_MODEL_API_KEY")
    model = env_value(
        dotenv,
        "BUA_CUA_GENERATION_MODEL",
        "BUA_CUA_RECOVERY_MODEL",
        "MIDSCENE_MODEL_NAME",
        default=DEFAULT_MODEL,
    )
    timeout = int(env_value(dotenv, "BUA_CUA_GENERATION_TIMEOUT", default="1800"))
    active_provider = os.environ.get("BUA_CUA_ACTIVE_PROVIDER")
    json_mode = active_provider != "minimax"
    disable_thinking = active_provider == "minimax"
    if not base_url or not api_key or not model:
        print("ERROR: Missing generation model config. Set BUA_CUA_GENERATION_* or BUA_CUA_RECOVERY_* in .env.", file=sys.stderr)
        return 1

    try:
        inputs = load_generation_inputs(args.task)
        print(f"Generating Task Skill metadata with model: {model}")
        metadata_files = generate_file_set(
            "metadata",
            build_metadata_generation_prompt(inputs),
            METADATA_GENERATED_FILES,
            validate_metadata_files,
            model,
            base_url,
            api_key,
            timeout,
            json_mode=json_mode,
            disable_thinking=disable_thinking,
        )
        print(f"Generating Task Skill index.ts with model: {model}")
        index_files = generate_file_set(
            "index.ts",
            build_index_generation_prompt(inputs, metadata_files),
            INDEX_GENERATED_FILES,
            validate_index_file,
            model,
            base_url,
            api_key,
            timeout,
            json_mode=json_mode,
            disable_thinking=disable_thinking,
        )
        files = {**metadata_files, **index_files}
        validate_generated_files(files)
        skill_dir = write_generated_skill(args.task, files, args.overwrite)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"Generated skill: {skill_dir}")
    return 0


def command_model_preflight(args: argparse.Namespace) -> int:
    dotenv = load_dotenv(ROOT / ".env")
    base_url = env_value(dotenv, "BUA_CUA_GENERATION_BASE_URL", "BUA_CUA_RECOVERY_BASE_URL", "MIDSCENE_MODEL_BASE_URL")
    api_key = env_value(dotenv, "BUA_CUA_GENERATION_API_KEY", "BUA_CUA_RECOVERY_API_KEY", "MIDSCENE_MODEL_API_KEY")
    model = env_value(
        dotenv,
        "BUA_CUA_GENERATION_MODEL",
        "BUA_CUA_RECOVERY_MODEL",
        "MIDSCENE_MODEL_NAME",
        default=DEFAULT_MODEL,
    )
    timeout = int(env_value(dotenv, "BUA_CUA_GENERATION_TIMEOUT", default=str(args.timeout)))
    disable_thinking = os.environ.get("BUA_CUA_ACTIVE_PROVIDER") == "minimax"
    if not base_url or not api_key or not model:
        print("ERROR: Missing model config. Set BUA_CUA_GENERATION_* or BUA_CUA_RECOVERY_* in .env.", file=sys.stderr)
        return 1

    try:
        content = call_chat_completion(
            [{"role": "user", "content": "只回复 ASCII 文本 pong"}],
            model,
            base_url,
            api_key,
            timeout,
            json_mode=False,
            disable_thinking=disable_thinking,
        )
    except Exception as exc:
        print(f"model={model}")
        print("status=error")
        print(f"error={str(exc).encode('ascii', errors='backslashreplace').decode('ascii')}")
        return 1

    print(f"model={model}")
    print("status=ok")
    print(f"reply={content.encode('ascii', errors='backslashreplace').decode('ascii')}")
    return 0
