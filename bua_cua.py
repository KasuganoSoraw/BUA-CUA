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

    entry = manifest.get("entry")
    if not isinstance(entry, str):
        errors.append("skill.json field `entry` must be a string")
    elif not (path / entry).exists():
        errors.append(f"Missing entry file: {path / entry}")

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


def command_trace_codegen(args: argparse.Namespace) -> int:
    target = ROOT / "inputs" / args.task
    codegen = target / "codegen.spec.ts"
    if not codegen.exists():
        print(f"ERROR: Missing codegen script: {codegen}", file=sys.stderr)
        return 1

    playwright = ROOT / "node_modules" / ".bin" / ("playwright.cmd" if sys.platform == "win32" else "playwright")
    if not playwright.exists():
        print("ERROR: Could not find local Playwright CLI. Run npm install first.", file=sys.stderr)
        return 1
    tsc = ROOT / "node_modules" / ".bin" / ("tsc.cmd" if sys.platform == "win32" else "tsc")
    if not tsc.exists():
        print("ERROR: Could not find local TypeScript compiler. Run npm install first.", file=sys.stderr)
        return 1

    trace_dir = target / "trace"
    results_dir = trace_dir / "test-results"
    compiled_dir = trace_dir / "compiled"
    trace_zip = trace_dir / "trace.zip"
    trace_dir.mkdir(parents=True, exist_ok=True)
    if results_dir.exists():
        shutil.rmtree(results_dir)
    if compiled_dir.exists():
        shutil.rmtree(compiled_dir)
    if trace_zip.exists():
        backup = trace_dir / f"trace-{int(time.time())}.zip"
        shutil.move(trace_zip, backup)
        print(f"Existing trace backed up: {backup}")

    compile_cmd = [
        str(tsc),
        str(codegen.resolve()),
        "--outDir",
        str(compiled_dir.resolve()),
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--target",
        "ES2022",
        "--skipLibCheck",
    ]
    compiled = subprocess.run(compile_cmd, cwd=ROOT)
    if compiled.returncode != 0:
        return compiled.returncode

    compiled_script = compiled_dir / codegen.with_suffix(".js").name
    if not compiled_script.exists():
        print(f"ERROR: Compiled script not found: {compiled_script}", file=sys.stderr)
        return 1

    cmd = [
        str(playwright),
        "test",
        compiled_script.relative_to(ROOT).as_posix(),
        "--trace",
        "on",
        "--output",
        str(results_dir.resolve()),
    ]
    if args.headed:
        cmd.append("--headed")
    if args.project:
        cmd.extend(["--project", args.project])

    completed = subprocess.run(cmd, cwd=ROOT)
    traces = sorted(results_dir.rglob("trace.zip"), key=lambda item: item.stat().st_mtime, reverse=True)
    if not traces:
        print(f"ERROR: No trace.zip found under {results_dir}", file=sys.stderr)
        return completed.returncode or 1

    shutil.copy2(traces[0], trace_zip)
    print(f"Trace saved: {trace_zip}")
    print(f"Open with: npx playwright show-trace {trace_zip}")
    return completed.returncode


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BUA-CUA Task Skill control CLI")
    subparsers = parser.add_subparsers(dest="command", required=True)

    scaffold = subparsers.add_parser("scaffold-input", help="create an input pack")
    scaffold.add_argument("task")
    scaffold.set_defaults(func=command_scaffold_input)

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

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
