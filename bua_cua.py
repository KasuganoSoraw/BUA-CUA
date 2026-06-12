#!/usr/bin/env python3
"""Control-plane CLI for the BUA-CUA Task Skill MVP."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from bua_cua_tools.generate import command_generate_skill, command_model_preflight
from bua_cua_tools.intent import (
    CONFIDENCE_THRESHOLD,
    load_skill_catalog,
    resolve_intent_with_model,
    resolve_runtime_config,
    run_skill_with_args,
    timestamp_for_run,
    validate_args_against_schema,
    write_resolution_artifacts,
)
from bua_cua_tools.providers import apply_provider_environment, selected_provider
from bua_cua_tools.recovery_cases import command_extract_recovery_cases
from bua_cua_tools.trace import command_summarize_trace, command_trace_codegen


ROOT = Path(__file__).resolve().parent
REQUIRED_SKILL_FIELDS = {
    "name",
    "type",
    "version",
    "entry",
    "argsSchema",
    "risk",
}

API_REGISTRY_STATUSES = {"candidate", "probed", "approved", "rejected"}
API_REGISTRY_RISKS = {"read_only", "write_review_required", "destructive_review_required"}
API_FALLBACK_POLICIES = {"gui_on_failure", "stop_on_uncertain", "forbidden"}
SENSITIVE_API_REGISTRY_TOKENS = {"apikey", "api_key", "authorization", "cookie", "set-cookie", "bearer"}
KNOWLEDGE_ARRAY_FIELDS = {"optionMappings", "recoveryCases", "selectorHints"}
SENSITIVE_KNOWLEDGE_TOKENS = {"apikey", "api_key", "authorization", "cookie", "set-cookie", "bearer"}


def skill_dir(name_or_path: str) -> Path:
    candidate = Path(name_or_path)
    if candidate.exists():
        return candidate.resolve()
    return (ROOT / "skills" / name_or_path).resolve()


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


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


def command_scaffold_input(args: argparse.Namespace) -> int:
    target = ROOT / "inputs" / args.task
    target.mkdir(parents=True, exist_ok=True)

    files = {
        "intent.md": "# Task Intent\n\nDescribe the business task and its parameters here.\n",
        "codegen.spec.ts": "// Paste Playwright codegen output here.\n",
        "steps.md": "# Optional Human Steps\n\nAdd clarifying business steps if needed.\n",
    }

    for filename, content in files.items():
        path = target / filename
        if not path.exists():
            path.write_text(content, encoding="utf-8")

    print(f"Input pack ready: {target}")
    return 0


def ensure_input_pack(task: str) -> Path:
    target = ROOT / "inputs" / task
    target.mkdir(parents=True, exist_ok=True)

    files = {
        "intent.md": "# Task Intent\n\nDescribe the business task and its parameters here.\n",
        "codegen.spec.ts": "// Paste Playwright codegen output here.\n",
        "steps.md": "# Optional Human Steps\n\nAdd clarifying business steps if needed.\n",
    }
    for filename, content in files.items():
        path = target / filename
        if not path.exists():
            path.write_text(content, encoding="utf-8")
    return target


def is_placeholder_codegen(path: Path) -> bool:
    if not path.exists():
        return True
    content = path.read_text(encoding="utf-8", errors="replace").strip()
    return not content or content == "// Paste Playwright codegen output here."


def command_codegen(args: argparse.Namespace) -> int:
    target = ensure_input_pack(args.task)
    output = target / "codegen.spec.ts"
    if output.exists() and not is_placeholder_codegen(output) and not args.overwrite:
        backup = target / f"codegen.spec.{int(time.time())}.bak.ts"
        shutil.move(output, backup)
        print(f"Existing codegen backed up: {backup}")

    playwright = ROOT / "node_modules" / ".bin" / ("playwright.cmd" if sys.platform == "win32" else "playwright")
    if not playwright.exists():
        print("ERROR: Could not find local Playwright CLI. Run npm install first.", file=sys.stderr)
        return 1

    cmd = [
        str(playwright),
        "codegen",
        "--target",
        args.target,
        "--output",
        str(output.resolve()),
    ]
    if args.browser:
        cmd.extend(["--browser", args.browser])
    if args.channel:
        cmd.extend(["--channel", args.channel])
    if args.user_data_dir:
        cmd.extend(["--user-data-dir", str(Path(args.user_data_dir).resolve())])
    if args.load_storage:
        cmd.extend(["--load-storage", str(Path(args.load_storage).resolve())])
    if args.save_storage:
        cmd.extend(["--save-storage", str(Path(args.save_storage).resolve())])
    if args.viewport_size:
        cmd.extend(["--viewport-size", args.viewport_size])
    if args.ignore_https_errors:
        cmd.append("--ignore-https-errors")
    if args.url:
        cmd.append(args.url)

    print(f"Input pack ready: {target}")
    print(f"Codegen output: {output}")
    completed = subprocess.run(cmd, cwd=ROOT)
    return completed.returncode


def validate_skill(path: Path) -> list[str]:
    errors: list[str] = []
    manifest_path = path / "skill.json"
    if not manifest_path.exists():
        return [f"Missing skill.json: {manifest_path}"]

    try:
        manifest = load_json(manifest_path)
    except json.JSONDecodeError as exc:
        return [f"Invalid JSON in {manifest_path}: {exc}"]

    missing = sorted(REQUIRED_SKILL_FIELDS - set(manifest))
    if missing:
        errors.append(f"Missing required fields: {', '.join(missing)}")

    if manifest.get("type") != "task":
        errors.append("skill.json field `type` must be `task`")

    if manifest.get("risk") not in {"read_only", "write_review_required", "destructive_review_required"}:
        errors.append("skill.json field `risk` must be one of read_only, write_review_required, destructive_review_required")

    entry = manifest.get("entry")
    if not isinstance(entry, str):
        errors.append("skill.json field `entry` must be a string")
    elif not (path / entry).exists():
        errors.append(f"Missing entry file: {path / entry}")

    inferred_intent = manifest.get("inferredIntent")
    if inferred_intent is not None:
        if not isinstance(inferred_intent, str):
            errors.append("skill.json field `inferredIntent` must be a string when present")
        elif not (path / inferred_intent).exists():
            errors.append(f"Missing inferred intent file: {path / inferred_intent}")

    api_registry = manifest.get("apiRegistry")
    if api_registry is not None:
        if not isinstance(api_registry, str):
            errors.append("skill.json field `apiRegistry` must be a string when present")
        elif not (path / api_registry).exists():
            errors.append(f"Missing API registry file: {path / api_registry}")
        else:
            try:
                registry = load_json(path / api_registry)
            except json.JSONDecodeError as exc:
                errors.append(f"Invalid JSON in API registry file {path / api_registry}: {exc}")
            else:
                if not isinstance(registry, dict):
                    errors.append(f"API registry file must contain a JSON object: {path / api_registry}")
                else:
                    registry_text = json.dumps(registry, ensure_ascii=False).lower()
                    if any(token in registry_text for token in SENSITIVE_API_REGISTRY_TOKENS):
                        errors.append("API registry must not contain API keys, cookies, authorization headers, or bearer tokens")
                    status = registry.get("status")
                    if status is not None and status not in API_REGISTRY_STATUSES:
                        errors.append("api_registry.json field `status` must be one of candidate, probed, approved, rejected")
                    risk = registry.get("risk")
                    if risk is not None and risk not in API_REGISTRY_RISKS:
                        errors.append("api_registry.json field `risk` must be one of read_only, write_review_required, destructive_review_required")
                    fallback_policy = registry.get("fallbackPolicy")
                    if fallback_policy is not None and fallback_policy not in API_FALLBACK_POLICIES:
                        errors.append("api_registry.json field `fallbackPolicy` must be one of gui_on_failure, stop_on_uncertain, forbidden")
                    fast_paths = registry.get("fastPaths", [])
                    if fast_paths is not None and not isinstance(fast_paths, list):
                        errors.append("api_registry.json field `fastPaths` must be an array when present")
                    for index, fast_path in enumerate(fast_paths if isinstance(fast_paths, list) else []):
                        if not isinstance(fast_path, dict):
                            errors.append(f"api_registry.json fastPaths[{index}] must be an object")
                            continue
                        if not isinstance(fast_path.get("id"), str) or not fast_path.get("id"):
                            errors.append(f"api_registry.json fastPaths[{index}].id must be a non-empty string")
                        if fast_path.get("status") not in API_REGISTRY_STATUSES:
                            errors.append(f"api_registry.json fastPaths[{index}].status must be one of candidate, probed, approved, rejected")
                        if fast_path.get("risk") not in API_REGISTRY_RISKS:
                            errors.append(f"api_registry.json fastPaths[{index}].risk must be one of read_only, write_review_required, destructive_review_required")
                        if fast_path.get("fallbackPolicy") is not None and fast_path.get("fallbackPolicy") not in API_FALLBACK_POLICIES:
                            errors.append(f"api_registry.json fastPaths[{index}].fallbackPolicy must be one of gui_on_failure, stop_on_uncertain, forbidden")

    knowledge = manifest.get("knowledge")
    if knowledge is not None:
        if not isinstance(knowledge, str):
            errors.append("skill.json field `knowledge` must be a string when present")
        elif not (path / knowledge).exists():
            errors.append(f"Missing knowledge file: {path / knowledge}")
        else:
            try:
                knowledge_payload = load_json(path / knowledge)
            except json.JSONDecodeError as exc:
                errors.append(f"Invalid JSON in knowledge file {path / knowledge}: {exc}")
            else:
                if not isinstance(knowledge_payload, dict):
                    errors.append(f"Knowledge file must contain a JSON object: {path / knowledge}")
                else:
                    knowledge_text = json.dumps(knowledge_payload, ensure_ascii=False).lower()
                    if any(token in knowledge_text for token in SENSITIVE_KNOWLEDGE_TOKENS):
                        errors.append("knowledge.json must not contain API keys, cookies, authorization headers, or bearer tokens")
                    if not isinstance(knowledge_payload.get("schemaVersion"), int):
                        errors.append("knowledge.json field `schemaVersion` must be an integer")
                    if "apiFastPaths" in knowledge_payload:
                        errors.append("knowledge.json must not contain apiFastPaths; keep API fast paths in api_registry.json")
                    for field in KNOWLEDGE_ARRAY_FIELDS:
                        if field in knowledge_payload and not isinstance(knowledge_payload[field], list):
                            errors.append(f"knowledge.json field `{field}` must be an array")

    if not (path / "SKILL.md").exists():
        errors.append(f"Missing SKILL.md: {path / 'SKILL.md'}")

    args_schema = manifest.get("argsSchema")
    if not isinstance(args_schema, dict):
        errors.append("skill.json field `argsSchema` must be a JSON Schema object")
    elif args_schema.get("type") != "object":
        errors.append("argsSchema.type must be `object`")

    pre_skills = manifest.get("preSkills", [])
    if pre_skills is not None and not isinstance(pre_skills, list):
        errors.append("preSkills must be an array when present")

    return errors


def command_validate_skill(args: argparse.Namespace) -> int:
    path = skill_dir(args.skill)
    errors = validate_skill(path)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1
    print(f"Skill is valid: {path}")
    return 0


def command_run_skill(args: argparse.Namespace) -> int:
    try:
        provider = selected_provider(args)
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    path = skill_dir(args.skill)
    errors = validate_skill(path)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    base_args = tsx_args("src/runtime/runner.ts")
    if base_args is None:
        return 1

    node_args = [
        *base_args,
        "--skill",
        str(path),
        "--args",
        str(Path(args.args).resolve()),
    ]
    if args.headless:
        node_args.append("--headless")
    if args.skip_pre_skills:
        node_args.append("--skip-pre-skills")
    if args.api_first:
        node_args.append("--api-first")
    if provider:
        node_args.append(f"--{provider}")

    completed = subprocess.run(node_args, cwd=ROOT)
    return completed.returncode


def command_run_intent(args: argparse.Namespace) -> int:
    try:
        provider = selected_provider(args)
        apply_provider_environment(provider, ROOT / ".env")
        model, base_url, api_key, timeout, json_mode, disable_thinking = resolve_runtime_config(args.timeout)
    except (RuntimeError, ValueError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    catalog = load_skill_catalog(only_skill=args.skill)
    if not catalog:
        if args.skill:
            print(f"ERROR: No runnable Task Skill found for --skill {args.skill}", file=sys.stderr)
        else:
            print("ERROR: No runnable Task Skills found under skills/.", file=sys.stderr)
        return 1

    try:
        resolution = resolve_intent_with_model(
            args.intent,
            catalog,
            model=model,
            base_url=base_url,
            api_key=api_key,
            timeout=timeout,
            only_skill=args.skill,
            json_mode=json_mode,
            disable_thinking=disable_thinking,
        )
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    selected = next(
        (item for item in catalog if resolution.skill in {item.get("directory"), item.get("name")}),
        None,
    )
    if selected is None:
        selected = next(
            (
                item
                for item in catalog
                if isinstance(item.get("directory"), str) and str(item["directory"]) in resolution.skill
            ),
            None,
        )
    if not selected:
        run_dir = ROOT / "runs" / f"{timestamp_for_run()}-intent"
        selected_manifest: dict[str, Any] = {}
        write_resolution_artifacts(
            resolution,
            intent=args.intent,
            run_dir=run_dir,
            selected_manifest=selected_manifest,
            validation_errors=[f"selected skill is not in catalog: {resolution.skill}"],
            selected_skill_directory=None,
        )
        print(f"ERROR: Model selected unknown skill: {resolution.skill}", file=sys.stderr)
        print(f"Intent resolution written to: {run_dir}")
        return 1

    selected_skill_dir = ROOT / "skills" / str(selected["directory"])
    manifest = load_json(selected_skill_dir / "skill.json")
    validation_errors = validate_args_against_schema(manifest.get("argsSchema", {}), resolution.args)
    run_dir = ROOT / "runs" / f"{timestamp_for_run()}-intent"
    args_path = write_resolution_artifacts(
        resolution,
        intent=args.intent,
        run_dir=run_dir,
        selected_manifest=manifest,
        validation_errors=validation_errors,
        selected_skill_directory=str(selected["directory"]),
    )

    print(f"Intent resolution written to: {run_dir}")
    print(f"Selected skill: {selected['directory']} (confidence={resolution.confidence:.2f})")
    print(f"Args: {args_path}")

    if resolution.confidence < args.confidence_threshold:
        print(
            f"ERROR: Intent confidence {resolution.confidence:.2f} is below threshold {args.confidence_threshold:.2f}.",
            file=sys.stderr,
        )
        return 1
    if resolution.missing:
        print(f"ERROR: Missing required intent parameters: {', '.join(resolution.missing)}", file=sys.stderr)
        return 1
    if validation_errors:
        print("ERROR: Resolved args do not match selected skill argsSchema:", file=sys.stderr)
        for error in validation_errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    if args.dry_run:
        print("Dry run complete; browser execution skipped.")
        return 0
    if manifest.get("risk") != "read_only":
        print(
            f"ERROR: Refusing to auto-run non-read-only skill `{selected['directory']}` with risk={manifest.get('risk')}.",
            file=sys.stderr,
        )
        return 1

    return run_skill_with_args(
        skill_dir=selected_skill_dir,
        args_path=args_path,
        headless=args.headless,
        skip_pre_skills=args.skip_pre_skills,
        api_first=args.api_first,
        provider=provider,
    )


def command_probe_api(args: argparse.Namespace) -> int:
    path = skill_dir(args.skill)
    errors = validate_skill(path)
    if errors:
        for error in errors:
            print(f"ERROR: {error}", file=sys.stderr)
        return 1

    manifest = load_json(path / "skill.json")
    if manifest.get("risk") != "read_only":
        print("ERROR: probe-api only supports read_only skills in the first version.", file=sys.stderr)
        return 1
    if not manifest.get("apiRegistry"):
        print("ERROR: skill.json has no apiRegistry field.", file=sys.stderr)
        return 1

    base_args = tsx_args("src/runtime/probe_api.ts")
    if base_args is None:
        return 1

    node_args = [
        *base_args,
        "--skill",
        str(path),
        "--args",
        str(Path(args.args).resolve()),
    ]
    if args.observe_gui:
        node_args.append("--observe-gui")
    if args.headless:
        node_args.append("--headless")
    completed = subprocess.run(node_args, cwd=ROOT)
    return completed.returncode


def command_generate_skill_with_provider(args: argparse.Namespace) -> int:
    try:
        provider = selected_provider(args)
        apply_provider_environment(provider, ROOT / ".env")
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return command_generate_skill(args)


def command_model_preflight_with_provider(args: argparse.Namespace) -> int:
    try:
        provider = selected_provider(args)
        apply_provider_environment(provider, ROOT / ".env")
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return command_model_preflight(args)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BUA-CUA Task Skill control CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scaffold = subparsers.add_parser("scaffold-input", help="create an input pack")
    scaffold.add_argument("task")
    scaffold.set_defaults(func=command_scaffold_input)

    codegen = subparsers.add_parser("codegen", help="create an input pack and run Playwright codegen into codegen.spec.ts")
    codegen.add_argument("task")
    codegen.add_argument("--url", help="optional start URL for Playwright codegen")
    codegen.add_argument("--target", default="playwright-test", help="Playwright codegen target, default: playwright-test")
    codegen.add_argument("--browser", help="browser type, for example chromium, firefox, or webkit")
    codegen.add_argument("--channel", help="optional Chromium channel, for example chrome or msedge")
    codegen.add_argument("--user-data-dir", help="optional persistent browser profile directory")
    codegen.add_argument("--load-storage", help="optional storage state file to load")
    codegen.add_argument("--save-storage", help="optional storage state file to save")
    codegen.add_argument("--viewport-size", help="browser viewport size, for example 1280,720")
    codegen.add_argument("--ignore-https-errors", action="store_true")
    codegen.add_argument("--overwrite", action="store_true", help="overwrite existing codegen.spec.ts without creating a backup")
    codegen.set_defaults(func=command_codegen)

    validate = subparsers.add_parser("validate-skill", help="validate a skill manifest")
    validate.add_argument("skill")
    validate.set_defaults(func=command_validate_skill)

    run = subparsers.add_parser("run-skill", help="run a skill through the Node runtime")
    run.add_argument("skill")
    run.add_argument("--args", required=True, help="path to skill args JSON")
    run.add_argument("--headless", action="store_true", help="run browser headless")
    run.add_argument("--skip-pre-skills", action="store_true")
    run.add_argument("--api-first", action="store_true", help="try probed/approved read-only API fast path before GUI")
    run.add_argument("--qwen", action="store_true", help="use qwen provider config from .env")
    run.add_argument("--minimax", action="store_true", help="use minimax provider config from .env")
    run.set_defaults(func=command_run_skill)

    run_intent = subparsers.add_parser("run-intent", help="resolve natural language intent into a Task Skill run")
    run_intent.add_argument("intent", help="natural language task intent")
    run_intent.add_argument("--skill", help="optional skill name; when set, only extract args for this skill")
    run_intent.add_argument("--dry-run", action="store_true", help="resolve intent and write args without running the browser")
    run_intent.add_argument("--headless", action="store_true", help="run browser headless")
    run_intent.add_argument("--skip-pre-skills", action="store_true")
    run_intent.add_argument("--api-first", action="store_true", help="try API fast path after intent resolution")
    run_intent.add_argument("--confidence-threshold", type=float, default=CONFIDENCE_THRESHOLD)
    run_intent.add_argument("--timeout", type=int, help="model request timeout in seconds")
    run_intent.add_argument("--qwen", action="store_true", help="use qwen provider config from .env")
    run_intent.add_argument("--minimax", action="store_true", help="use minimax provider config from .env")
    run_intent.set_defaults(func=command_run_intent)

    probe = subparsers.add_parser("probe-api", help="probe and solidify a read-only API fast path for a skill")
    probe.add_argument("skill")
    probe.add_argument("--args", required=True, help="path to skill args JSON")
    probe.add_argument("--observe-gui", action="store_true", help="run the GUI mainline while capturing live network API observations")
    probe.add_argument("--headless", action="store_true", help="use headless browser for --observe-gui")
    probe.set_defaults(func=command_probe_api)

    recovery_cases = subparsers.add_parser(
        "extract-recovery-cases",
        help="extract structured recovery_cases.json from a runtime JSONL log",
    )
    recovery_cases.add_argument("run", help="run id, partial run id, or path to runs/<run-id>.jsonl")
    recovery_cases.add_argument("--output-dir", help="optional output directory; defaults to runs/<run-id>/")
    recovery_cases.set_defaults(func=command_extract_recovery_cases)

    trace = subparsers.add_parser("trace-codegen", help="run an input codegen script with Playwright trace enabled")
    trace.add_argument("task")
    trace.add_argument("--headed", action="store_true", help="run browser headed")
    trace.add_argument("--project", help="optional Playwright project name")
    trace.set_defaults(func=command_trace_codegen)

    summarize = subparsers.add_parser("summarize-trace", help="extract facts from a Playwright trace.zip")
    summarize.add_argument("task")
    summarize.add_argument("--trace", help="optional path to trace.zip; defaults to inputs/<task>/trace/trace.zip")
    summarize.set_defaults(func=command_summarize_trace)

    generate = subparsers.add_parser("generate-skill", help="generate a Task Skill from intent, codegen, and trace evidence")
    generate.add_argument("task")
    generate.add_argument("--overwrite", action="store_true", help="overwrite an existing non-empty skills/<task> directory")
    generate.add_argument("--qwen", action="store_true", help="use qwen provider config from .env")
    generate.add_argument("--minimax", action="store_true", help="use minimax provider config from .env")
    generate.set_defaults(func=command_generate_skill_with_provider)

    preflight = subparsers.add_parser("model-preflight", help="check OpenAI-compatible model connectivity")
    preflight.add_argument("--timeout", type=int, default=180, help="request timeout in seconds")
    preflight.add_argument("--qwen", action="store_true", help="use qwen provider config from .env")
    preflight.add_argument("--minimax", action="store_true", help="use minimax provider config from .env")
    preflight.set_defaults(func=command_model_preflight_with_provider)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
