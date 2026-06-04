#!/usr/bin/env python3
"""Control-plane CLI for the BUA-CUA Task Skill MVP."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import time
import zipfile
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


TRACE_ACTION_METHODS = {
    "goto",
    "click",
    "dblclick",
    "fill",
    "press",
    "selectOption",
    "check",
    "uncheck",
    "setInputFiles",
    "hover",
}


def sanitize_id(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "-", value).strip("-")


def read_jsonl_from_zip(archive: zipfile.ZipFile, name: str) -> list[dict[str, Any]]:
    if name not in archive.namelist():
        return []
    records: list[dict[str, Any]] = []
    for line in archive.read(name).decode("utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return records


def compact_log_message(message: str) -> str:
    return re.sub(r"\s+", " ", message).strip()


def extract_resolved_html(logs: list[str]) -> str | None:
    for message in logs:
        match = re.search(r"locator resolved to (.+)$", message)
        if match:
            return match.group(1).strip()
    return None


def parse_codegen_action_lines(codegen: Path) -> list[dict[str, Any]]:
    action_lines: list[dict[str, Any]] = []
    if not codegen.exists():
        return action_lines
    for line_number, line in enumerate(codegen.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if not stripped.startswith("await "):
            continue
        if not any(f".{method}(" in stripped or f"page.{method}(" in stripped for method in TRACE_ACTION_METHODS):
            continue
        action_lines.append(
            {
                "line": line_number,
                "text": stripped,
            }
        )
    return action_lines


def html_text_from_trace_node(node: Any, values: list[str], limit: int = 80) -> None:
    if len(values) >= limit:
        return
    if isinstance(node, str):
        text = re.sub(r"\s+", " ", node).strip()
        if len(text) >= 2 and text not in values:
            values.append(text[:240])
        return
    if not isinstance(node, list):
        return
    if node and isinstance(node[0], int):
        return
    tag = str(node[0]).upper() if node else ""
    if tag in {"SCRIPT", "STYLE", "NOSCRIPT", "HEAD", "META", "LINK"}:
        return
    for child in node[2:]:
        html_text_from_trace_node(child, values, limit)


def frame_snapshot_text(snapshot: dict[str, Any] | None) -> list[str]:
    if not snapshot:
        return []
    values: list[str] = []
    html_text_from_trace_node(snapshot.get("html"), values)
    return values[:40]


def nearest_frame(
    frames: list[dict[str, Any]],
    page_id: str | None,
    timestamp: float | None,
    direction: str,
) -> dict[str, Any] | None:
    if page_id:
        candidates = [frame for frame in frames if frame.get("pageId") == page_id]
    else:
        candidates = list(frames)
    if not candidates:
        return None
    if timestamp is None:
        return candidates[-1]
    if direction == "before":
        before = [frame for frame in candidates if float(frame.get("timestamp", 0)) <= timestamp]
        return before[-1] if before else candidates[0]
    if direction == "after":
        after = [frame for frame in candidates if float(frame.get("timestamp", 0)) >= timestamp]
        return after[0] if after else candidates[-1]
    return min(candidates, key=lambda frame: abs(float(frame.get("timestamp", 0)) - timestamp))


def copy_frame_image(
    archive: zipfile.ZipFile,
    frame: dict[str, Any] | None,
    image_dir: Path,
    action_id: str,
    label: str,
) -> str | None:
    if not frame or not frame.get("sha1"):
        return None
    source = f"resources/{frame['sha1']}"
    if source not in archive.namelist():
        return None
    suffix = Path(str(frame["sha1"])).suffix or ".jpeg"
    target = image_dir / f"{sanitize_id(action_id)}-{label}{suffix}"
    target.write_bytes(archive.read(source))
    return target.relative_to(image_dir.parent).as_posix()


def command_summarize_trace(args: argparse.Namespace) -> int:
    target = ROOT / "inputs" / args.task
    trace_zip = Path(args.trace).resolve() if args.trace else target / "trace" / "trace.zip"
    codegen = target / "codegen.spec.ts"
    if not trace_zip.exists():
        print(f"ERROR: Missing trace zip: {trace_zip}", file=sys.stderr)
        return 1

    trace_dir = target / "trace"
    image_dir = trace_dir / "evidence-images"
    if image_dir.exists():
        shutil.rmtree(image_dir)
    image_dir.mkdir(parents=True, exist_ok=True)

    codegen_actions = parse_codegen_action_lines(codegen)

    with zipfile.ZipFile(trace_zip) as archive:
        browser_trace_name = next((name for name in archive.namelist() if name.endswith("-trace.trace")), None)
        if not browser_trace_name:
            print("ERROR: Could not find browser trace file in trace.zip", file=sys.stderr)
            return 1
        browser_records = read_jsonl_from_zip(archive, browser_trace_name)
        test_records = read_jsonl_from_zip(archive, "test.trace")

        frames = [record for record in browser_records if record.get("type") == "screencast-frame"]
        snapshots = {
            record["snapshot"]["snapshotName"]: record["snapshot"]
            for record in browser_records
            if record.get("type") == "frame-snapshot" and isinstance(record.get("snapshot"), dict)
        }

        calls: dict[str, dict[str, Any]] = {}
        order: list[str] = []
        for record in browser_records:
            call_id = record.get("callId")
            if not call_id:
                continue
            call = calls.setdefault(call_id, {"logs": []})
            if call_id not in order:
                order.append(call_id)
            if record.get("type") == "before":
                call.update(
                    {
                        "callId": call_id,
                        "method": record.get("method"),
                        "class": record.get("class"),
                        "params": record.get("params", {}),
                        "startTime": record.get("startTime"),
                        "pageId": record.get("pageId"),
                        "beforeSnapshot": record.get("beforeSnapshot"),
                    }
                )
            elif record.get("type") == "input":
                call["inputSnapshot"] = record.get("inputSnapshot")
            elif record.get("type") == "after":
                call["endTime"] = record.get("endTime")
                call["afterSnapshot"] = record.get("afterSnapshot")
                if record.get("error"):
                    call["error"] = record.get("error")
            elif record.get("type") == "log":
                message = compact_log_message(str(record.get("message", "")))
                if message:
                    call["logs"].append(message)

        test_errors = [record for record in test_records if record.get("type") == "error"]
        action_calls = [
            calls[call_id]
            for call_id in order
            if calls.get(call_id, {}).get("method") in TRACE_ACTION_METHODS
        ]

        evidence_actions: list[dict[str, Any]] = []
        failed_action: dict[str, Any] | None = None
        for index, call in enumerate(action_calls):
            action_id = str(call.get("callId"))
            before_snapshot = snapshots.get(call.get("beforeSnapshot"))
            input_snapshot = snapshots.get(call.get("inputSnapshot"))
            after_snapshot = snapshots.get(call.get("afterSnapshot"))
            status = "failed" if call.get("error") or not call.get("endTime") else "passed"
            if status == "failed" and failed_action is None:
                failed_action = call

            before_frame = nearest_frame(frames, call.get("pageId"), call.get("startTime"), "before")
            action_frame = nearest_frame(frames, call.get("pageId"), call.get("startTime"), "nearest")
            after_frame = nearest_frame(frames, call.get("pageId"), call.get("endTime"), "after")
            selected_frames = {
                "before": copy_frame_image(archive, before_frame, image_dir, action_id, "before"),
                "action": copy_frame_image(archive, action_frame, image_dir, action_id, "action"),
                "after": copy_frame_image(archive, after_frame, image_dir, action_id, "after"),
            }

            source = codegen_actions[index] if index < len(codegen_actions) else None
            before_url = before_snapshot.get("frameUrl") if before_snapshot else None
            after_url = after_snapshot.get("frameUrl") if after_snapshot else None
            before_text = frame_snapshot_text(before_snapshot)
            after_text = frame_snapshot_text(after_snapshot)
            action = {
                "id": action_id,
                "codegenActionIndex": index,
                "source": source,
                "method": call.get("method"),
                "class": call.get("class"),
                "params": call.get("params", {}),
                "status": status,
                "timing": {
                    "startTime": call.get("startTime"),
                    "endTime": call.get("endTime"),
                },
                "snapshots": {
                    "before": call.get("beforeSnapshot"),
                    "action": call.get("inputSnapshot"),
                    "after": call.get("afterSnapshot"),
                },
                "selectedFrames": selected_frames,
                "state": {
                    "beforeUrl": before_url,
                    "afterUrl": after_url,
                    "urlChanged": bool(before_url and after_url and before_url != after_url),
                    "beforeTextSample": before_text[:12],
                    "afterTextSample": after_text[:12],
                },
                "resolvedHtml": extract_resolved_html(call.get("logs", [])),
                "logs": call.get("logs", [])[:12],
                "error": call.get("error"),
            }
            evidence_actions.append(action)

        covered = len(evidence_actions)
        failed_index = next((i for i, action in enumerate(evidence_actions) if action["status"] == "failed"), None)
        if failed_index is None and covered >= len(codegen_actions):
            trace_status = "passed"
        elif covered == 0:
            trace_status = "failed"
        else:
            trace_status = "partial"

        error_contexts = []
        for path in sorted((target / "trace" / "test-results").rglob("error-context.md")):
            error_contexts.append(path.read_text(encoding="utf-8", errors="replace"))

        output = {
            "schemaVersion": 1,
            "taskName": args.task,
            "traceZip": trace_zip.relative_to(ROOT).as_posix() if trace_zip.is_relative_to(ROOT) else str(trace_zip),
            "sourceCodegen": codegen.relative_to(ROOT).as_posix() if codegen.exists() else None,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "traceStatus": trace_status,
            "coverage": {
                "codegenActionCount": len(codegen_actions),
                "traceActionCount": covered,
                "failedActionIndex": failed_index,
                "coveredCodegenActions": min(covered, len(codegen_actions)),
                "uncoveredCodegenActions": codegen_actions[covered:],
            },
            "actions": evidence_actions,
            "failure": {
                "action": evidence_actions[failed_index] if failed_index is not None else None,
                "testErrors": test_errors,
                "errorContexts": error_contexts,
            }
            if failed_index is not None or test_errors or error_contexts
            else None,
            "notes": [
                "This file contains engineering-extracted facts from Playwright trace.zip.",
                "It does not contain model-generated semantic step descriptions.",
                "selectedFrames are sampled from Playwright screencast frames and are auxiliary visual evidence.",
            ],
        }

    output_path = trace_dir / "trace_evidence.json"
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Trace evidence saved: {output_path}")
    print(f"Evidence images saved: {image_dir}")
    print(f"Trace status: {output['traceStatus']}")
    return 0


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

    summarize = subparsers.add_parser("summarize-trace", help="extract facts from a Playwright trace.zip")
    summarize.add_argument("task")
    summarize.add_argument("--trace", help="optional path to trace.zip; defaults to inputs/<task>/trace/trace.zip")
    summarize.set_defaults(func=command_summarize_trace)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
