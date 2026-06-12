"""Extract structured recovery cases from runtime JSONL logs."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
RECOVERY_EVENT_TYPES = {
    "primary_failed",
    "verify_failed",
    "recovery_initial_screenshot",
    "recovery_initial_full_page_screenshot",
    "recovery_start",
    "recovery_tool_start",
    "recovery_tool_end",
    "recovery_success",
    "recovery_failed",
    "recovery_verify_failed",
    "midscene_fallback_start",
    "midscene_fallback_end",
    "midscene_fallback_failed",
    "step_failed",
}


def truncate_text(value: str, max_chars: int = 1200) -> str:
    if len(value) <= max_chars:
        return value
    return value[: max_chars - 20].rstrip() + "...[truncated]"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    events: list[dict[str, Any]] = []
    for line_no, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Invalid JSONL at {path}:{line_no}: {exc}") from exc
        if isinstance(event, dict):
            event["_line"] = line_no
            events.append(event)
    return events


def resolve_run_log(run: str) -> Path:
    candidate = Path(run)
    if candidate.exists():
        return candidate.resolve()
    runs_dir = ROOT / "runs"
    direct = runs_dir / f"{run}.jsonl"
    if direct.exists():
        return direct.resolve()
    matches = sorted(runs_dir.glob(f"*{run}*.jsonl"), key=lambda item: item.stat().st_mtime, reverse=True)
    if len(matches) == 1:
        return matches[0].resolve()
    if len(matches) > 1:
        names = "\n  ".join(str(path.name) for path in matches[:10])
        raise ValueError(f"Run id is ambiguous. Matching JSONL files:\n  {names}")
    raise FileNotFoundError(f"Could not find run JSONL: {run}")


def output_dir_for_run(log_path: Path, run_id: str) -> Path:
    runs_dir = ROOT / "runs"
    direct = runs_dir / run_id
    direct.mkdir(parents=True, exist_ok=True)
    return direct


def event_summary(event: dict[str, Any]) -> dict[str, Any]:
    summary: dict[str, Any] = {
        "line": event.get("_line"),
        "timestamp": event.get("timestamp"),
        "level": event.get("level"),
        "type": event.get("type"),
    }
    if event.get("message") is not None:
        summary["message"] = event.get("message")
    return summary


def compact_event_data(data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    compacted: dict[str, Any] = {}
    if "screenshotPath" in data:
        compacted["screenshotPath"] = data["screenshotPath"]
    if "timeoutMs" in data:
        compacted["timeoutMs"] = data["timeoutMs"]
    if "args" in data:
        compacted["args"] = compact_tool_input(data["args"])
    if "result" in data:
        compacted["result"] = compact_tool_result(data["result"])
    return compacted or {"keys": list(data.keys())[:20]}


def compact_tool_input(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    compacted = dict(value)
    if isinstance(compacted.get("code"), str):
        compacted["code"] = truncate_text(compacted["code"], 1400)
    return compacted


def compact_tool_result(result: Any) -> Any:
    if isinstance(result, dict):
        kept: dict[str, Any] = {}
        for key in (
            "ok",
            "reason",
            "clicked",
            "states",
            "url",
            "href",
            "applied",
            "selected",
            "resolved",
            "resolvedTargets",
            "evidence",
        ):
            if key in result:
                kept[key] = result[key]
        if kept:
            return kept
        return {
            "kind": "object",
            "keys": list(result.keys())[:20],
            "sample": {key: compact_tool_result(value) for key, value in list(result.items())[:5]},
        }
    if isinstance(result, list):
        return {
            "kind": "array",
            "length": len(result),
            "sample": [compact_tool_result(item) for item in result[:5]],
        }
    if isinstance(result, str) and len(result) > 1000:
        return truncate_text(result, 1000)
    return result


def build_tool_calls(events: list[dict[str, Any]]) -> list[dict[str, Any]]:
    calls: list[dict[str, Any]] = []
    pending: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        event_type = event.get("type")
        tool = event.get("message")
        if event_type == "recovery_tool_start" and isinstance(tool, str):
            call = {
                "tool": tool,
                "startLine": event.get("_line"),
                "startedAt": event.get("timestamp"),
                "input": compact_tool_input(event.get("data", {}).get("args")) if isinstance(event.get("data"), dict) else None,
            }
            pending.setdefault(tool, []).append(call)
            calls.append(call)
        elif event_type == "recovery_tool_end" and isinstance(tool, str):
            queue = pending.get(tool) or []
            call = queue.pop(0) if queue else {
                "tool": tool,
                "startLine": None,
                "startedAt": None,
                "input": None,
            }
            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            call.update(
                {
                    "endLine": event.get("_line"),
                    "endedAt": event.get("timestamp"),
                    "result": compact_tool_result(data.get("result")),
                }
            )
            if call not in calls:
                calls.append(call)
    return calls


def screenshot_artifacts(events: list[dict[str, Any]]) -> dict[str, Any]:
    artifacts: dict[str, Any] = {}
    for event in events:
        event_type = event.get("type")
        data = event.get("data") if isinstance(event.get("data"), dict) else {}
        path = data.get("screenshotPath") or event.get("message")
        if not isinstance(path, str):
            continue
        if event_type == "recovery_initial_screenshot":
            artifacts["initialViewportScreenshot"] = path
        elif event_type == "recovery_initial_full_page_screenshot":
            artifacts["initialFullPageScreenshot"] = path
        elif event_type == "step_failed":
            artifacts["failedScreenshot"] = path
    return artifacts


def classify_failure(events: list[dict[str, Any]]) -> dict[str, Any]:
    for event_type in ("primary_failed", "verify_failed"):
        event = next((item for item in events if item.get("type") == event_type), None)
        if event:
            return {
                "kind": event_type,
                "message": event.get("message"),
                "line": event.get("_line"),
                "timestamp": event.get("timestamp"),
            }
    return {"kind": "unknown"}


def classify_verification(events: list[dict[str, Any]]) -> dict[str, Any]:
    if any(event.get("type") == "step_failed" for event in events):
        failed = next(event for event in reversed(events) if event.get("type") == "step_failed")
        return {
            "status": "failed",
            "failureKind": "step_failed",
            "message": failed.get("message"),
            "line": failed.get("_line"),
        }
    if any(event.get("type") == "recovery_verify_failed" for event in events):
        failed = next(event for event in reversed(events) if event.get("type") == "recovery_verify_failed")
        return {
            "status": "failed",
            "failureKind": "recovery_verify_failed",
            "message": failed.get("message"),
            "line": failed.get("_line"),
        }
    if any(event.get("type") == "recovery_success" for event in events):
        return {"status": "passed_after_recovery"}
    return {"status": "unknown"}


def extract_cases(events: list[dict[str, Any]], log_path: Path) -> dict[str, Any]:
    run_id = next((event.get("runId") for event in events if event.get("runId")), log_path.stem)
    skill = next((event.get("skill") for event in events if event.get("skill")), None)
    run_start = next((event for event in events if event.get("type") == "run_start"), {})
    events_by_step: dict[str, list[dict[str, Any]]] = {}
    for event in events:
        step = event.get("step")
        if isinstance(step, str) and event.get("type") in RECOVERY_EVENT_TYPES:
            events_by_step.setdefault(step, []).append(event)

    cases: list[dict[str, Any]] = []
    for step_name, step_events in events_by_step.items():
        if not any(event.get("type") in {"recovery_start", "recovery_success", "recovery_failed"} for event in step_events):
            continue
        recovery_start = next((event for event in step_events if event.get("type") == "recovery_start"), {})
        case = {
            "id": f"{run_id}:{len(cases) + 1}",
            "runId": run_id,
            "skill": skill,
            "step": {
                "name": step_name,
                "goal": recovery_start.get("message"),
            },
            "failure": classify_failure(step_events),
            "recovery": {
                "status": "succeeded" if any(event.get("type") == "recovery_success" for event in step_events)
                else "failed" if any(event.get("type") == "recovery_failed" for event in step_events)
                else "attempted",
                "toolCalls": build_tool_calls(step_events),
            },
            "verification": classify_verification(step_events),
            "artifacts": screenshot_artifacts(step_events),
            "source": {
                "logPath": str(log_path),
                "eventLines": [event.get("_line") for event in step_events],
            },
            "events": [event_summary(event) for event in step_events],
        }
        cases.append(case)

    return {
        "schemaVersion": 1,
        "runId": run_id,
        "skill": skill,
        "skillDir": (run_start.get("data") or {}).get("skillDir") if isinstance(run_start.get("data"), dict) else None,
        "sourceLog": str(log_path),
        "cases": cases,
    }


def command_extract_recovery_cases(args: argparse.Namespace) -> int:
    try:
        log_path = resolve_run_log(args.run)
        events = read_jsonl(log_path)
        payload = extract_cases(events, log_path)
        run_id = payload["runId"]
        output_dir = Path(args.output_dir).resolve() if args.output_dir else output_dir_for_run(log_path, str(run_id))
        output_dir.mkdir(parents=True, exist_ok=True)
        output_path = output_dir / "recovery_cases.json"
        output_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(f"Recovery cases written to: {output_path}")
    print(f"Cases: {len(payload.get('cases', []))}")
    return 0
