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

    completed = subprocess.run(node_args, cwd=ROOT)
    return completed.returncode


def command_record(args: argparse.Namespace) -> int:
    target = ROOT / "inputs" / args.task
    target.mkdir(parents=True, exist_ok=True)
    recording_dir = target / "recording"
    recording_dir.mkdir(parents=True, exist_ok=True)

    base_args = tsx_args("recorder/index.ts")
    if base_args is None:
        return 1

    node_args = [
        *base_args,
        "--task",
        args.task,
        "--url",
        args.url,
        "--output",
        str(recording_dir.resolve()),
    ]
    if args.user_data_dir:
        node_args.extend(["--user-data-dir", str(Path(args.user_data_dir).resolve())])
    if args.channel:
        node_args.extend(["--channel", args.channel])

    process = subprocess.Popen(node_args, cwd=ROOT)
    try:
        return process.wait()
    except KeyboardInterrupt:
        print("\nRecorder interrupted. Waiting briefly for recording files to flush...", file=sys.stderr)
        try:
            return process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                return process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                return process.wait()


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
    run.set_defaults(func=command_run_skill)

    record = subparsers.add_parser("record", help="record raw browser evidence for an input pack")
    record.add_argument("task")
    record.add_argument("--url", required=True, help="start URL for headed enhanced recording")
    record.add_argument("--user-data-dir", help="optional persistent browser profile directory")
    record.add_argument("--channel", help="optional Playwright browser channel, for example chrome or msedge")
    record.set_defaults(func=command_record)

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
    generate.set_defaults(func=command_generate_skill)

    preflight = subparsers.add_parser("model-preflight", help="check OpenAI-compatible model connectivity")
    preflight.add_argument("--timeout", type=int, default=180, help="request timeout in seconds")
    preflight.set_defaults(func=command_model_preflight)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
