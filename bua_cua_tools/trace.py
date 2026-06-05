"""Playwright trace capture and evidence extraction helpers."""

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


ROOT = Path(__file__).resolve().parents[1]

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
    config_path = trace_dir / "playwright.trace.config.cjs"
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

    config_path.write_text(
        "\n".join(
            [
                "const { defineConfig } = require('@playwright/test');",
                "",
                "module.exports = defineConfig({",
                "  testDir: './compiled',",
                "  testMatch: /.*\\.spec\\.js$/,",
                "  respectGitIgnore: false,",
                "});",
                "",
            ]
        ),
        encoding="utf-8",
    )

    cmd = [
        str(playwright),
        "test",
        "--config",
        str(config_path.resolve()),
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


def normalize_point(point: Any) -> dict[str, Any] | None:
    if not isinstance(point, dict):
        return None
    x = point.get("x")
    y = point.get("y")
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return None
    return {
        "x": x,
        "y": y,
        "coordinateSpace": "viewport",
        "note": "Point is captured from Playwright trace input event and is only valid for the recorded viewport.",
    }


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
                call["inputPoint"] = normalize_point(record.get("point"))
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
                "inputPoint": call.get("inputPoint"),
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
                "inputPoint coordinates are viewport-local and should be interpreted with the selected action frame.",
                "selectedFrames are sampled from Playwright screencast frames and are auxiliary visual evidence.",
            ],
        }

    output_path = trace_dir / "trace_evidence.json"
    output_path.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Trace evidence saved: {output_path}")
    print(f"Evidence images saved: {image_dir}")
    print(f"Trace status: {output['traceStatus']}")
    return 0
