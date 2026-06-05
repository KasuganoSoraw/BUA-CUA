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
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MODEL = "qwen3.6-plus-2026-04-02"
REQUIRED_GENERATED_FILES = {
    "skill.json",
    "SKILL.md",
    "INFERRED_INTENT.md",
    "index.ts",
    "fixtures/input.example.json",
}
RISK_VALUES = {"read_only", "write_review_required", "destructive_review_required"}


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
                "params": action.get("params"),
                "inputPoint": action.get("inputPoint"),
                "status": action.get("status"),
                "selectedFrames": action.get("selectedFrames"),
                "state": action.get("state"),
                "resolvedHtml": action.get("resolvedHtml"),
                "error": action.get("error"),
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


def build_generation_prompt(task: str) -> list[dict[str, str]]:
    input_dir = ROOT / "inputs" / task
    codegen_path = input_dir / "codegen.spec.ts"
    trace_evidence_path = input_dir / "trace" / "trace_evidence.json"
    prompt_path = ROOT / "prompts" / "task_skill_generation.md"

    if not codegen_path.exists():
        raise FileNotFoundError(f"Missing codegen script: {codegen_path}")
    if not trace_evidence_path.exists():
        raise FileNotFoundError(f"Missing trace evidence: {trace_evidence_path}")

    intent = read_optional(input_dir / "intent.md")
    steps = read_optional(input_dir / "steps.md")
    trace_evidence = compact_trace_evidence(json.loads(trace_evidence_path.read_text(encoding="utf-8")))

    user_intent = intent if not is_placeholder(intent) else "用户未提供真实自然语言意图，请根据 codegen 和 trace_evidence 推断任务目标。"
    user_steps = steps if not is_placeholder(steps) else "用户未提供人工步骤说明。"

    system_prompt = (
        "你是 BUA-CUA Toolkit 的 Task Skill 生成模型。"
        "你必须严格根据输入事实生成文件内容，不得编造没有证据的页面状态。"
        "输出必须是一个 JSON 对象，格式为 {\"files\": {\"path\": \"content\"}}，不要输出 Markdown 代码围栏。"
    )
    user_prompt = f"""
下面是 Task Skill 生成规范：

{prompt_path.read_text(encoding="utf-8")}

请为任务 `{task}` 生成 Task Skill 文件。

输出约束：
- 只能输出 JSON 对象，不能输出解释性文字。
- JSON 顶层必须是 `files`。
- `files` 必须且只能包含这些路径：
  - skill.json
  - SKILL.md
  - INFERRED_INTENT.md
  - index.ts
  - fixtures/input.example.json
- `skill.json.name` 应使用 `{task}`。
- `skill.json.inferredIntent` 必须是 `INFERRED_INTENT.md`。
- TypeScript 代码必须可被当前项目 `npm run typecheck` 检查。
- 生成内容必须使用中文说明；代码 API、路径、字段名保持英文。
- 不要生成 `recordings/codegen.spec.ts`，该文件由工具复制原始 codegen。

用户自然语言意图：

```md
{user_intent}
```

用户人工步骤说明：

```md
{user_steps}
```

Playwright codegen 脚本：

```ts
{codegen_path.read_text(encoding="utf-8")}
```

工程提取的 trace_evidence.json：

```json
{json.dumps(trace_evidence, ensure_ascii=False, indent=2)}
```
"""
    return [
        {"role": "system", "content": system_prompt},
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
) -> str:
    payload = {
        "model": model,
        "messages": messages,
        "temperature": 0.1,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
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


def validate_generated_files(files: dict[str, str]) -> None:
    manifest = json.loads(files["skill.json"])
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
    index_ts = files["index.ts"]
    if "withRecovery(" not in index_ts and "recoverStep(" not in index_ts:
        raise ValueError("Generated index.ts must use ctx.withRecovery or ctx.recoverStep for webpage operation steps")
    if re.search(r"getByText\([^)]*selected[^)]*\)\)\.toBeVisible", index_ts):
        raise ValueError(
            "Generated verifier must not use page.getByText('* selected').toBeVisible(); "
            "it can match hidden download radio labels. Verify checked state, visible result area, or download event instead."
        )
    fixture = json.loads(files["fixtures/input.example.json"])
    if not isinstance(fixture, dict):
        raise ValueError("Generated fixtures/input.example.json must be a JSON object")


def parse_generation(content: str) -> dict[str, str]:
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    payload = json.loads(text)
    files = payload.get("files")
    if not isinstance(files, dict):
        raise ValueError("Generation output must contain object field `files`")
    unknown = set(files) - REQUIRED_GENERATED_FILES
    missing = REQUIRED_GENERATED_FILES - set(files)
    if unknown or missing:
        raise ValueError(f"Invalid generated file set. missing={sorted(missing)} unknown={sorted(unknown)}")
    normalized: dict[str, str] = {}
    for relative_path, content_value in files.items():
        if not isinstance(content_value, str):
            raise ValueError(f"Generated file content must be string: {relative_path}")
        normalized[relative_path] = content_value
    validate_generated_files(normalized)
    return normalized


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
    timeout = int(env_value(dotenv, "BUA_CUA_GENERATION_TIMEOUT", default="600"))
    if not base_url or not api_key or not model:
        print("ERROR: Missing generation model config. Set BUA_CUA_GENERATION_* or BUA_CUA_RECOVERY_* in .env.", file=sys.stderr)
        return 1

    try:
        messages = build_generation_prompt(args.task)
        print(f"Generating Task Skill with model: {model}")
        last_error: Exception | None = None
        files: dict[str, str] | None = None
        for attempt in range(1, 3):
            content = call_chat_completion(messages, model, base_url, api_key, timeout)
            try:
                files = parse_generation(content)
                break
            except Exception as exc:
                last_error = exc
                messages.append({"role": "assistant", "content": content})
                messages.append(
                    {
                        "role": "user",
                        "content": (
                            "上一次输出不符合 BUA-CUA 文件契约，请只返回修正后的 JSON。"
                            f"错误信息：{exc}"
                        ),
                    }
                )
                print(f"Generation attempt {attempt} failed validation: {exc}", file=sys.stderr)
        if files is None:
            raise RuntimeError(f"Generation failed validation: {last_error}")
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
        )
    except Exception as exc:
        print(f"model={model}")
        print(f"status=error")
        print(f"error={str(exc).encode('ascii', errors='backslashreplace').decode('ascii')}")
        return 1

    print(f"model={model}")
    print("status=ok")
    print(f"reply={content.encode('ascii', errors='backslashreplace').decode('ascii')}")
    return 0
