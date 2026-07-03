#!/usr/bin/env python3
"""Repo-local production quality gate.

The global AI governance dispatcher calls this script as:

    python -X utf8 scripts/quality_gate.py --level full

It intentionally delegates to the repository's existing npm gates instead of
duplicating test logic here. The full gate also auto-selects a real eval replay
record when KCW_EVAL_REPLAY_RECORDS is not already set, because `npm run ci`
fails closed without one.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Iterable


REPO_ROOT = Path(__file__).resolve().parents[1]
REPLAY_DIR = REPO_ROOT / "output" / "eval-replay"


class GateError(RuntimeError):
    """Raised when the gate cannot continue safely."""


def npm_command() -> str:
    resolved = shutil.which("npm")
    if not resolved:
        raise GateError("npm was not found on PATH")
    return resolved


def command_label(command: Iterable[str]) -> str:
    return " ".join(str(part) for part in command)


def run_step(name: str, command: list[str], env: dict[str, str], timeout_sec: int) -> None:
    started = time.time()
    print(f"\n[quality-gate] {name}: {command_label(command)}", flush=True)
    try:
        completed = subprocess.run(
            command,
            cwd=REPO_ROOT,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        duration = time.time() - started
        raise GateError(f"{name} timed out after {duration:.1f}s") from exc
    if completed.returncode != 0:
        duration = time.time() - started
        raise GateError(f"{name} failed after {duration:.1f}s with exit code {completed.returncode}")
    duration = time.time() - started
    print(f"[quality-gate] {name} passed in {duration:.1f}s", flush=True)


def parse_json_or_jsonl(path: Path) -> int:
    try:
        text = path.read_text(encoding="utf-8-sig").strip()
    except OSError as exc:
        raise GateError(f"failed to read eval replay records: {path}") from exc
    if not text:
        raise GateError(f"eval replay record is empty: {path}")
    try:
        parsed = json.loads(text)
        if isinstance(parsed, list):
            return len(parsed)
        if isinstance(parsed, dict) and isinstance(parsed.get("records"), list):
            return len(parsed["records"])
        raise GateError(f"eval replay JSON must be an array or {{ records }}: {path}")
    except json.JSONDecodeError:
        count = 0
        for line_number, line in enumerate(text.splitlines(), start=1):
            if not line.strip():
                continue
            try:
                json.loads(line)
            except json.JSONDecodeError as exc:
                raise GateError(f"eval replay JSONL parse failed at line {line_number}: {path}") from exc
            count += 1
        return count


def candidate_replay_records() -> list[Path]:
    if not REPLAY_DIR.exists():
        return []
    candidates = [
        path
        for path in REPLAY_DIR.iterdir()
        if path.is_file()
        and path.name.startswith("model-records-")
        and path.suffix.lower() in {".json", ".jsonl"}
    ]

    def score(path: Path) -> tuple[int, int, float]:
        name = path.name.lower()
        return (
            1 if "merged" in name else 0,
            0 if "failed" in name or "repair" in name else 1,
            path.stat().st_mtime,
        )

    return sorted(candidates, key=score, reverse=True)


def resolve_replay_records(env: dict[str, str]) -> Path:
    explicit = env.get("KCW_EVAL_REPLAY_RECORDS", "").strip()
    if explicit:
        path = Path(explicit).expanduser()
        if not path.is_absolute():
            path = (REPO_ROOT / path).resolve()
        if not path.exists():
            raise GateError(f"KCW_EVAL_REPLAY_RECORDS does not exist: {path}")
        count = parse_json_or_jsonl(path)
        if count <= 0:
            raise GateError(f"KCW_EVAL_REPLAY_RECORDS contains no records: {path}")
        return path

    for path in candidate_replay_records():
        try:
            count = parse_json_or_jsonl(path)
        except (OSError, json.JSONDecodeError, GateError):
            continue
        if count > 0:
            env["KCW_EVAL_REPLAY_RECORDS"] = str(path)
            return path

    raise GateError(
        "No usable eval replay records found. Set KCW_EVAL_REPLAY_RECORDS to a real JSON/JSONL ModelRecorder file."
    )


def build_steps(level: str, npm: str) -> list[tuple[str, list[str], int]]:
    if level == "quick":
        return [
            ("check", [npm, "run", "check"], 900),
        ]
    return [
        ("security:local-strict", [npm, "run", "security:local-strict"], 900),
        ("build:ui", [npm, "run", "build:ui"], 900),
        ("smoke:playwright-all", [npm, "run", "smoke:playwright-all"], 1200),
        ("ci", [npm, "run", "ci"], 1800),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Agent Cowork quality gates.")
    parser.add_argument("--level", choices=["quick", "full"], default="quick")
    args = parser.parse_args()

    env = os.environ.copy()
    env["CI"] = "1"
    env["PYTHONUTF8"] = "1"

    try:
        npm = npm_command()
        if args.level == "full":
            replay_path = resolve_replay_records(env)
            print(f"[quality-gate] eval replay records: {replay_path}", flush=True)
        for name, command, timeout_sec in build_steps(args.level, npm):
            run_step(name, command, env, timeout_sec)
    except GateError as error:
        print(f"[quality-gate] failed: {error}", file=sys.stderr, flush=True)
        return 1

    print(f"\n[quality-gate] {args.level} gate passed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
