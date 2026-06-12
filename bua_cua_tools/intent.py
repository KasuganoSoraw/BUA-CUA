"""Natural language intent resolution for BUA-CUA Task Skills."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from bua_cua_tools.generate import DEFAULT_MODEL, call_chat_completion, env_value, load_dotenv


ROOT = Path(__file__).resolve().parents[1]
CONFIDENCE_THRESHOLD = 0.7
MAX_DOC_CHARS = 2400
MAX_DESCRIPTION_CHARS = 700


@dataclass(frozen=True)
class IntentResolution:
    skill: str
    confidence: float
    args: dict[str, Any]
    missing: list[str]
    assumptions: list[str]
    reason: str


def read_text(path: Path, max_chars: int = MAX_DOC_CHARS) -> str:
    if not path.exists():
        return ""
    text = path.read_text(encoding="utf-8", errors="replace").strip()
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 24].rstrip() + "\n...[truncated]"


def read_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def compact_schema(schema: Any) -> Any:
    if not isinstance(schema, dict):
        return schema
    compacted: dict[str, Any] = {
        "type": schema.get("type"),
        "required": schema.get("required", []),
        "additionalProperties": schema.get("additionalProperties"),
        "properties": {},
    }
    properties = schema.get("properties")
    if isinstance(properties, dict):
        for name, prop in properties.items():
            if not isinstance(prop, dict):
                compacted["properties"][name] = prop
                continue
            compacted["properties"][name] = {
                key: prop[key]
                for key in (
                    "type",
                    "description",
                    "enum",
                    "default",
                    "minimum",
                    "maximum",
                    "minLength",
                    "maxLength",
                )
                if key in prop
            }
    return compacted


def load_skill_catalog(skills_root: Path = ROOT / "skills", only_skill: str | None = None) -> list[dict[str, Any]]:
    catalog: list[dict[str, Any]] = []
    if not skills_root.exists():
        return catalog
    for skill_dir in sorted(path for path in skills_root.iterdir() if path.is_dir()):
        if only_skill and skill_dir.name != only_skill:
            continue
        manifest_path = skill_dir / "skill.json"
        if not manifest_path.exists():
            continue
        try:
            manifest = read_json(manifest_path)
        except Exception:
            continue
        if manifest.get("type") != "task":
            continue
        skill_md = read_text(skill_dir / "SKILL.md", 1600)
        inferred = read_text(skill_dir / str(manifest.get("inferredIntent", "INFERRED_INTENT.md")), 1600)
        catalog.append(
            {
                "directory": skill_dir.name,
                "name": manifest.get("name", skill_dir.name),
                "description": str(manifest.get("description", ""))[:MAX_DESCRIPTION_CHARS],
                "risk": manifest.get("risk"),
                "requiresSession": manifest.get("requiresSession", False),
                "preSkills": manifest.get("preSkills", []),
                "apiRegistry": manifest.get("apiRegistry"),
                "argsSchema": compact_schema(manifest.get("argsSchema", {})),
                "skillSummary": skill_md,
                "inferredIntent": inferred,
            }
        )
    return catalog


def strip_code_fence(text: str) -> str:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)
    return stripped.strip()


def parse_resolution(content: str) -> IntentResolution:
    payload = json.loads(strip_code_fence(content))
    if not isinstance(payload, dict):
        raise ValueError("Intent resolution must be a JSON object")
    skill = payload.get("skill")
    confidence = payload.get("confidence")
    args = payload.get("args")
    missing = payload.get("missing", [])
    assumptions = payload.get("assumptions", [])
    reason = payload.get("reason", "")
    if not isinstance(skill, str) or not skill:
        raise ValueError("Intent resolution field `skill` must be a non-empty string")
    if not isinstance(confidence, int | float):
        raise ValueError("Intent resolution field `confidence` must be a number")
    if not isinstance(args, dict):
        raise ValueError("Intent resolution field `args` must be an object")
    if not isinstance(missing, list) or not all(isinstance(item, str) for item in missing):
        raise ValueError("Intent resolution field `missing` must be a string array")
    if not isinstance(assumptions, list) or not all(isinstance(item, str) for item in assumptions):
        raise ValueError("Intent resolution field `assumptions` must be a string array")
    if not isinstance(reason, str):
        raise ValueError("Intent resolution field `reason` must be a string")
    return IntentResolution(
        skill=skill,
        confidence=float(confidence),
        args=args,
        missing=missing,
        assumptions=assumptions,
        reason=reason,
    )


def schema_type_matches(expected: str, value: Any) -> bool:
    if expected == "string":
        return isinstance(value, str)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "number":
        return isinstance(value, int | float) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    if expected == "array":
        return isinstance(value, list)
    if expected == "object":
        return isinstance(value, dict)
    if expected == "null":
        return value is None
    return True


def validate_args_against_schema(schema: dict[str, Any], args: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if schema.get("type") != "object":
        return ["argsSchema.type must be object"]
    required = schema.get("required", [])
    if isinstance(required, list):
        for name in required:
            if isinstance(name, str) and name not in args:
                errors.append(f"missing required property `{name}`")
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        properties = {}
    if schema.get("additionalProperties") is False:
        for name in args:
            if name not in properties:
                errors.append(f"additional property `{name}` is not allowed")
    for name, value in args.items():
        prop = properties.get(name)
        if not isinstance(prop, dict):
            continue
        expected_type = prop.get("type")
        if isinstance(expected_type, str) and not schema_type_matches(expected_type, value):
            errors.append(f"`{name}` must be {expected_type}, got {type(value).__name__}")
            continue
        if isinstance(prop.get("enum"), list) and value not in prop["enum"]:
            errors.append(f"`{name}` must be one of {prop['enum']}, got {value!r}")
        if isinstance(value, str):
            if isinstance(prop.get("minLength"), int) and len(value) < prop["minLength"]:
                errors.append(f"`{name}` length must be >= {prop['minLength']}")
            if isinstance(prop.get("maxLength"), int) and len(value) > prop["maxLength"]:
                errors.append(f"`{name}` length must be <= {prop['maxLength']}")
        if isinstance(value, int | float) and not isinstance(value, bool):
            if isinstance(prop.get("minimum"), int | float) and value < prop["minimum"]:
                errors.append(f"`{name}` must be >= {prop['minimum']}")
            if isinstance(prop.get("maximum"), int | float) and value > prop["maximum"]:
                errors.append(f"`{name}` must be <= {prop['maximum']}")
    return errors


def build_resolution_prompt(intent: str, catalog: list[dict[str, Any]], only_skill: str | None) -> list[dict[str, str]]:
    scope = (
        f"本次用户已经指定只能使用 `{only_skill}`，你只需要抽取参数。"
        if only_skill
        else "本次需要先从候选 Task Skill 中选择最匹配的一个，再抽取参数。"
    )
    return [
        {
            "role": "system",
            "content": (
                "你是 BUA-CUA Toolkit 的运行时意图解析器。"
                "你的任务是根据用户自然语言意图，选择一个已有 Task Skill，并生成该 Skill 的运行参数。"
                "不要生成代码，不要修改 Skill，不要猜测网页未支持的参数映射。"
                "必须只返回 JSON 对象。"
            ),
        },
        {
            "role": "user",
            "content": json.dumps(
                {
                    "instructions": [
                        scope,
                        "只允许选择 catalog 中的 directory/name。",
                        "args 必须符合所选 skill 的 argsSchema。",
                        "fixtures/input.example.json 只是录制样例；不要把样例默认值当作用户本次真实输入。",
                        "必填参数若无法从用户意图中明确抽取，且没有安全的任务默认值，请放入 missing，不要盲目套用录制值。",
                        "可选参数如果使用 schema default，必须在 assumptions 中说明。",
                        "如果用户给出的值不在 enum 中，不能自行映射或改写，应保留原意并让校验失败，或把该参数放入 missing。",
                        "confidence 取 0 到 1。过于模糊、多个 skill 都可能匹配时应降低 confidence。",
                        "只返回字段：skill, confidence, args, missing, assumptions, reason。",
                    ],
                    "userIntent": intent,
                    "skillCatalog": catalog,
                    "outputShape": {
                        "skill": "skills directory name",
                        "confidence": 0.0,
                        "args": {},
                        "missing": [],
                        "assumptions": [],
                        "reason": "short Chinese reason",
                    },
                },
                ensure_ascii=False,
                indent=2,
            ),
        },
    ]


def resolve_intent_with_model(
    intent: str,
    catalog: list[dict[str, Any]],
    *,
    model: str,
    base_url: str,
    api_key: str,
    timeout: int,
    only_skill: str | None = None,
    json_mode: bool = True,
    disable_thinking: bool = False,
) -> IntentResolution:
    messages = build_resolution_prompt(intent, catalog, only_skill)
    last_error: Exception | None = None
    for attempt in range(1, 3):
        content = call_chat_completion(
            messages,
            model,
            base_url,
            api_key,
            timeout,
            json_mode=json_mode,
            disable_thinking=disable_thinking,
        )
        try:
            return parse_resolution(content)
        except Exception as exc:
            last_error = exc
            messages.append({"role": "assistant", "content": content})
            messages.append(
                {
                    "role": "user",
                    "content": (
                        "上一轮输出不是合法的 intent resolution JSON。"
                        "请只返回修正后的 JSON，不要解释。"
                        f"错误：{exc}"
                    ),
                }
            )
            print(f"Intent resolution attempt {attempt} failed validation: {exc}", file=sys.stderr)
    raise RuntimeError(f"Intent resolution failed validation: {last_error}")


def timestamp_for_run() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S-%fZ")


def write_resolution_artifacts(
    resolution: IntentResolution,
    *,
    intent: str,
    run_dir: Path,
    selected_manifest: dict[str, Any],
    validation_errors: list[str],
    selected_skill_directory: str | None = None,
) -> Path:
    run_dir.mkdir(parents=True, exist_ok=True)
    args_path = run_dir / "args.json"
    resolution_path = run_dir / "intent_resolution.json"
    args_path.write_text(json.dumps(resolution.args, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    resolution_payload = {
        "schemaVersion": 1,
        "intent": intent,
        "skill": resolution.skill,
        "selectedSkillDirectory": selected_skill_directory or resolution.skill,
        "confidence": resolution.confidence,
        "args": resolution.args,
        "missing": resolution.missing,
        "assumptions": resolution.assumptions,
        "reason": resolution.reason,
        "selectedSkillRisk": selected_manifest.get("risk"),
        "validationErrors": validation_errors,
        "argsPath": str(args_path),
    }
    resolution_path.write_text(json.dumps(resolution_payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return args_path


def tsx_args(entry: str) -> list[str] | None:
    node = shutil.which("node.exe") or shutil.which("node")
    if not node:
        print("ERROR: Could not find node. Install Node.js and run npm install first.", file=sys.stderr)
        return None
    tsx_cli = ROOT / "node_modules" / "tsx" / "dist" / "cli.mjs"
    if not tsx_cli.exists():
        print("ERROR: Could not find local tsx. Run npm install first.", file=sys.stderr)
        return None
    return [node, str(tsx_cli), entry]


def run_skill_with_args(
    *,
    skill_dir: Path,
    args_path: Path,
    headless: bool,
    skip_pre_skills: bool,
    api_first: bool,
    provider: str | None,
) -> int:
    base_args = tsx_args("src/runtime/runner.ts")
    if base_args is None:
        return 1
    node_args = [
        *base_args,
        "--skill",
        str(skill_dir.resolve()),
        "--args",
        str(args_path.resolve()),
    ]
    if headless:
        node_args.append("--headless")
    if skip_pre_skills:
        node_args.append("--skip-pre-skills")
    if api_first:
        node_args.append("--api-first")
    if provider:
        node_args.append(f"--{provider}")
    completed = subprocess.run(node_args, cwd=ROOT)
    return completed.returncode


def resolve_runtime_config(timeout: int | None = None) -> tuple[str, str, str, int, bool, bool]:
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
    request_timeout = timeout or int(env_value(dotenv, "BUA_CUA_GENERATION_TIMEOUT", default="1800"))
    active_provider = os.environ.get("BUA_CUA_ACTIVE_PROVIDER")
    json_mode = active_provider != "minimax"
    disable_thinking = active_provider == "minimax"
    if not base_url or not api_key or not model:
        raise RuntimeError("Missing model config. Set BUA_CUA_GENERATION_* or BUA_CUA_RECOVERY_* in .env.")
    return model, base_url, api_key, request_timeout, json_mode, disable_thinking
