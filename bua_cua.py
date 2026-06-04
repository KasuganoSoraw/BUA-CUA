#!/usr/bin/env python3
"""Control-plane CLI for the BUA-CUA Task Skill MVP."""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
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

    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if not npx:
        print("ERROR: Could not find npx. Install Node.js and run npm install first.", file=sys.stderr)
        return 1

    node_args = [
        npx,
        "tsx",
        "src/runtime/runner.ts",
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

    npx = shutil.which("npx.cmd") or shutil.which("npx")
    if not npx:
        print("ERROR: Could not find npx. Install Node.js and run npm install first.", file=sys.stderr)
        return 1

    node_args = [
        npx,
        "tsx",
        "recorder/index.ts",
        "--task",
        args.task,
        "--url",
        args.url,
        "--output",
        str(recording_dir.resolve()),
    ]

    completed = subprocess.run(node_args, cwd=ROOT)
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
    record.set_defaults(func=command_record)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
