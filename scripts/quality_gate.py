#!/usr/bin/env python3
"""Repo-local source quality gate.

The global AI governance dispatcher calls this script as:

    python -X utf8 scripts/quality_gate.py --level full

It intentionally delegates to the repository's existing npm gates instead of
duplicating test logic here. The full gate uses a version-controlled replay
fixture when KCW_EVAL_REPLAY_RECORDS is not already set, because `npm run ci`
fails closed without one.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Iterable


SCRIPT_ROOT = Path(__file__).resolve().parent
if str(SCRIPT_ROOT) not in sys.path:
    sys.path.insert(0, str(SCRIPT_ROOT))

from quality_gate_process import ProcessTreeTimeout, run_process  # noqa: E402


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_REPLAY_RECORDS = REPO_ROOT / "eval" / "fixtures" / "ci-model-records.json"
TAURI_ROOT = REPO_ROOT / "apps" / "windows-client" / "src-tauri"
UI_ROOT = REPO_ROOT / "apps" / "windows-client" / "ui"
EMBEDDED_PYTHON_REQUIREMENTS_LOCK = (
    REPO_ROOT / "apps" / "windows-client" / "resources" / "python-packages.lock"
)
EMBEDDED_PYTHON_BOOTSTRAP_LOCK = (
    REPO_ROOT / "apps" / "windows-client" / "resources" / "python-bootstrap.lock"
)
GO_MODULE_ROOTS = (
    REPO_ROOT / "apps" / "local-agent",
    REPO_ROOT / "services" / "api",
    REPO_ROOT / "services" / "relay",
    REPO_ROOT / "services" / "orchestrator",
    REPO_ROOT / "services" / "kimi-gateway",
)
WINDOWS_RELEASE_TARGET = "x86_64-pc-windows-msvc"
PINNED_GO_TOOLCHAIN = (
    Path.home() / ".agents" / "toolchains" / "go1.26.5" / "go" / "bin" / "go.exe"
)
IGNORED_RUST_ADVISORIES = {
    "RUSTSEC-2024-0429": "glib",
}
PINNED_AUDIT_TOOL_VERSIONS = {
    "npm": "10.9.8",
    "cargo-audit": "0.22.2",
    "govulncheck": "v1.6.0",
    "pip-audit": "2.10.1",
}
NPM_AUDIT_ARGS = (
    "audit",
    "--audit-level=high",
    "--registry=https://registry.npmjs.org",
)
PIP_AUDIT_ARGS = (
    "--require-hashes",
    "--disable-pip",
    "--strict",
    "--vulnerability-service",
    "pypi",
    "--progress-spinner=off",
    "--timeout",
    "30",
)


class GateError(RuntimeError):
    """Raised when the gate cannot continue safely."""


GateStep = tuple[str, list[str], int, Path]


def npm_command() -> str:
    resolved = shutil.which("npm")
    if not resolved:
        raise GateError("npm was not found on PATH")
    return resolved


def cargo_command() -> str:
    resolved = shutil.which("cargo")
    if not resolved:
        raise GateError("cargo was not found on PATH")
    return resolved


def go_command() -> str:
    if PINNED_GO_TOOLCHAIN.is_file():
        return str(PINNED_GO_TOOLCHAIN)
    resolved = shutil.which("go")
    if not resolved:
        raise GateError("go was not found on PATH; install the version pinned by the repository go.mod files")
    return resolved


def cargo_audit_command() -> str:
    resolved = shutil.which("cargo-audit")
    if not resolved:
        version = PINNED_AUDIT_TOOL_VERSIONS["cargo-audit"]
        raise GateError(
            "cargo-audit was not found on PATH; install the pinned tool with "
            f"cargo install cargo-audit --locked --version {version}"
        )
    return resolved


def govulncheck_command() -> str:
    resolved = shutil.which("govulncheck")
    if not resolved:
        version = PINNED_AUDIT_TOOL_VERSIONS["govulncheck"]
        raise GateError(
            "govulncheck was not found on PATH; install the pinned tool with "
            f"go install golang.org/x/vuln/cmd/govulncheck@{version}"
        )
    return resolved


def pip_audit_command() -> list[str]:
    resolved = shutil.which("pip-audit")
    if not resolved:
        version = PINNED_AUDIT_TOOL_VERSIONS["pip-audit"]
        raise GateError(
            "pip-audit was not found on PATH; install the pinned tool explicitly with "
            f"python -m pip install pip-audit=={version}"
        )
    return [resolved]


def command_output(
    name: str,
    command: list[str],
    env: dict[str, str],
    cwd: Path = REPO_ROOT,
) -> str:
    try:
        completed = run_process(
            command,
            cwd=cwd,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            capture_output=True,
            timeout=60,
            check=False,
        )
    except ProcessTreeTimeout as exc:
        detail = exc.diagnostics(streamed=False)
        suffix = f"; {detail}" if detail else ""
        raise GateError(
            f"failed to probe {name}: {command_label(command)}{suffix}"
        ) from exc
    except OSError as exc:
        raise GateError(f"failed to start probe {name}: {command_label(command)}: {exc}") from exc
    output = f"{completed.stdout}\n{completed.stderr}".strip()
    if completed.returncode != 0:
        raise GateError(
            f"{name} version probe failed with exit code {completed.returncode}: {output}"
        )
    return output


def required_go_version() -> str:
    versions: dict[str, list[str]] = {}
    for module_root in GO_MODULE_ROOTS:
        go_mod = module_root / "go.mod"
        try:
            text = go_mod.read_text(encoding="utf-8")
        except OSError as exc:
            raise GateError(f"failed to read frozen Go module: {go_mod}") from exc
        match = re.search(r"^go\s+(\S+)\s*$", text, flags=re.MULTILINE)
        if not match:
            raise GateError(f"frozen Go module has no go version directive: {go_mod}")
        versions.setdefault(match.group(1), []).append(str(go_mod.relative_to(REPO_ROOT)))
    if len(versions) != 1:
        details = "; ".join(
            f"{version}: {', '.join(paths)}" for version, paths in sorted(versions.items())
        )
        raise GateError(f"Go module versions must be locked to one value: {details}")
    return next(iter(versions))


def verify_pip_audit_tool(pip_audit: list[str], env: dict[str, str]) -> None:
    required = PINNED_AUDIT_TOOL_VERSIONS["pip-audit"]
    output = command_output("pip-audit", [*pip_audit, "--version"], env)
    match = re.fullmatch(r"pip-audit\s+(\S+)", output.strip())
    observed = match.group(1) if match else output
    if observed != required:
        raise GateError(
            f"pip-audit version mismatch: required {required}, observed {observed}"
        )


def verify_ignored_rust_advisories_not_in_shipping_target(
    cargo: str,
    env: dict[str, str],
) -> None:
    output = command_output(
        "cargo metadata for ignored Rust advisories",
        [
            cargo,
            "metadata",
            "--format-version",
            "1",
            "--locked",
            "--filter-platform",
            WINDOWS_RELEASE_TARGET,
        ],
        env,
        TAURI_ROOT,
    )
    try:
        metadata = json.loads(output)
        packages = metadata["packages"]
        nodes = metadata["resolve"]["nodes"]
        package_names = {package["id"]: package["name"] for package in packages}
        resolved_names = {package_names[node["id"]] for node in nodes}
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise GateError("cargo metadata returned an invalid Windows release dependency graph") from exc

    for advisory, package_name in IGNORED_RUST_ADVISORIES.items():
        if package_name in resolved_names:
            raise GateError(
                f"ignored Rust advisory {advisory} now affects the Windows release graph "
                f"through package {package_name}; remove the ignore and remediate the dependency"
            )


def embedded_python_audit_steps(
    pip_audit: list[str],
) -> list[GateStep]:
    locks = (
        ("runtime", EMBEDDED_PYTHON_REQUIREMENTS_LOCK),
        ("bootstrap", EMBEDDED_PYTHON_BOOTSTRAP_LOCK),
    )
    steps: list[GateStep] = []
    for label, lock_path in locks:
        try:
            lock_is_file = lock_path.is_file()
            lock_size = lock_path.stat().st_size if lock_is_file else 0
        except OSError as exc:
            raise GateError(
                f"failed to inspect embedded Python {label} lock: {lock_path}"
            ) from exc
        if not lock_is_file or lock_size <= 0:
            raise GateError(
                f"embedded Python {label} lock is missing or empty: {lock_path}"
            )
        steps.append((
            f"pip:audit-embedded-python-{label}",
            [
                *pip_audit,
                "--requirement",
                str(lock_path),
                *PIP_AUDIT_ARGS,
            ],
            900,
            REPO_ROOT,
        ))
    return steps


def verify_pinned_audit_tools(
    npm: str,
    cargo: str,
    cargo_audit: str,
    go: str,
    govulncheck: str,
    pip_audit: list[str],
    env: dict[str, str],
) -> None:
    verify_pip_audit_tool(pip_audit, env)
    npm_version = PINNED_AUDIT_TOOL_VERSIONS["npm"]
    npm_output = command_output("npm", [npm, "--version"], env)
    if npm_output != npm_version:
        raise GateError(
            f"npm version mismatch: required {npm_version}, observed {npm_output}"
        )

    cargo_audit_version = PINNED_AUDIT_TOOL_VERSIONS["cargo-audit"]
    cargo_audit_output = command_output(
        "cargo-audit",
        [cargo_audit, "--version"],
        env,
        TAURI_ROOT,
    )
    if f"cargo-audit {cargo_audit_version}" not in cargo_audit_output:
        raise GateError(
            f"cargo-audit version mismatch: required {cargo_audit_version}, "
            f"observed {cargo_audit_output}"
        )
    verify_ignored_rust_advisories_not_in_shipping_target(cargo, env)

    govulncheck_version = PINNED_AUDIT_TOOL_VERSIONS["govulncheck"]
    govulncheck_output = command_output(
        "govulncheck",
        [govulncheck, "-version"],
        env,
    )
    if "govulncheck" not in govulncheck_output.lower() or govulncheck_version not in govulncheck_output:
        raise GateError(
            f"govulncheck version mismatch: required {govulncheck_version}, "
            f"observed {govulncheck_output}"
        )

    go_version = required_go_version()
    go_output = command_output("go", [go, "version"], env)
    if f"go{go_version}" not in go_output:
        raise GateError(
            f"Go toolchain version mismatch: required go{go_version}, observed {go_output}"
        )


def command_label(command: Iterable[str]) -> str:
    return " ".join(str(part) for part in command)


def run_step(
    name: str,
    command: list[str],
    env: dict[str, str],
    timeout_sec: int,
    cwd: Path = REPO_ROOT,
) -> None:
    started = time.time()
    print(f"\n[quality-gate] {name}: {command_label(command)}", flush=True)
    try:
        completed = run_process(
            command,
            cwd=cwd,
            env=env,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_sec,
            check=False,
        )
    except ProcessTreeTimeout as exc:
        duration = time.time() - started
        detail = exc.diagnostics(streamed=True)
        raise GateError(f"{name} timed out after {duration:.1f}s; {detail}") from exc
    except OSError as exc:
        raise GateError(f"{name} could not start: {exc}") from exc
    if completed.returncode != 0:
        duration = time.time() - started
        raise GateError(f"{name} failed after {duration:.1f}s with exit code {completed.returncode}")
    duration = time.time() - started
    print(f"[quality-gate] {name} passed in {duration:.1f}s", flush=True)


def govulncheck_concurrency(env: dict[str, str]) -> int:
    variable = "KCW_GOVULNCHECK_CONCURRENCY"
    raw_value = env.get(variable, "3").strip()
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise GateError(f"{variable} must be an integer between 1 and {len(GO_MODULE_ROOTS)}") from exc
    if not 1 <= value <= len(GO_MODULE_ROOTS):
        raise GateError(f"{variable} must be between 1 and {len(GO_MODULE_ROOTS)}; observed {raw_value!r}")
    return value


def run_parallel_steps(
    steps: list[GateStep],
    env: dict[str, str],
    max_workers: int,
) -> None:
    def execute(step: GateStep) -> tuple[str, float, int, str, str]:
        name, command, timeout_sec, cwd = step
        started = time.time()
        try:
            completed = run_process(
                command,
                cwd=cwd,
                env=env,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=timeout_sec,
                check=False,
                capture_output=True,
            )
        except ProcessTreeTimeout as exc:
            duration = time.time() - started
            detail = exc.diagnostics(streamed=False)
            raise GateError(f"{name} timed out after {duration:.1f}s; {detail}") from exc
        except OSError as exc:
            raise GateError(f"{name} could not start: {exc}") from exc
        return (
            name,
            time.time() - started,
            completed.returncode,
            completed.stdout or "",
            completed.stderr or "",
        )

    for name, command, _timeout_sec, _cwd in steps:
        print(f"\n[quality-gate] {name}: {command_label(command)}", flush=True)

    failures: list[str] = []
    with ThreadPoolExecutor(max_workers=max_workers, thread_name_prefix="govulncheck") as executor:
        pending = {executor.submit(execute, step): step[0] for step in steps}
        for future in as_completed(pending):
            name = pending[future]
            try:
                completed_name, duration, returncode, stdout, stderr = future.result()
            except GateError as error:
                failures.append(str(error))
                continue
            except Exception as error:  # pragma: no cover - defensive fail-closed boundary
                failures.append(f"{name} crashed: {error}")
                continue

            if stdout:
                print(stdout, end="" if stdout.endswith("\n") else "\n", flush=True)
            if stderr:
                print(stderr, end="" if stderr.endswith("\n") else "\n", file=sys.stderr, flush=True)
            if returncode != 0:
                failures.append(
                    f"{completed_name} failed after {duration:.1f}s with exit code {returncode}"
                )
                continue
            print(f"[quality-gate] {completed_name} passed in {duration:.1f}s", flush=True)

    if failures:
        raise GateError("parallel Go vulnerability audits failed: " + "; ".join(failures))


def run_gate_steps(steps: list[GateStep], env: dict[str, str]) -> None:
    index = 0
    while index < len(steps):
        if not steps[index][0].startswith("govulncheck:"):
            name, command, timeout_sec, cwd = steps[index]
            run_step(name, command, env, timeout_sec, cwd)
            index += 1
            continue

        group_end = index
        while group_end < len(steps) and steps[group_end][0].startswith("govulncheck:"):
            group_end += 1
        run_parallel_steps(
            steps[index:group_end],
            env,
            min(govulncheck_concurrency(env), group_end - index),
        )
        index = group_end


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


def resolve_replay_records(env: dict[str, str]) -> Path:
    explicit = env.get("KCW_EVAL_REPLAY_RECORDS", "").strip()
    path = Path(explicit).expanduser() if explicit else DEFAULT_REPLAY_RECORDS
    if not path.is_absolute():
        path = (REPO_ROOT / path).resolve()
    if not path.exists():
        label = "KCW_EVAL_REPLAY_RECORDS" if explicit else "version-controlled CI eval replay fixture"
        raise GateError(f"{label} does not exist: {path}")
    count = parse_json_or_jsonl(path)
    if count <= 0:
        raise GateError(f"eval replay record contains no records: {path}")
    env["KCW_EVAL_REPLAY_RECORDS"] = str(path)
    return path


def build_steps(
    level: str,
    npm: str,
    cargo: str | None = None,
    cargo_audit: str | None = None,
    govulncheck: str | None = None,
    pip_audit: list[str] | None = None,
) -> list[GateStep]:
    if level == "quick":
        return [
            ("check", [npm, "run", "check"], 900, REPO_ROOT),
        ]
    if not cargo or not cargo_audit or not govulncheck or not pip_audit:
        raise GateError(
            "cargo, cargo-audit, govulncheck, and pip-audit are required for the full quality gate"
        )
    steps = [
        *embedded_python_audit_steps(pip_audit),
        ("npm:audit-root", [npm, *NPM_AUDIT_ARGS], 900, REPO_ROOT),
        ("npm:audit-ui", [npm, *NPM_AUDIT_ARGS], 900, UI_ROOT),
        (
            "cargo:audit",
            [cargo_audit, "audit", "--deny", "unsound", "--ignore", "RUSTSEC-2024-0429"],
            900,
            TAURI_ROOT,
        ),
        *[
            (
                f"govulncheck:{module_root.relative_to(REPO_ROOT).as_posix()}",
                [govulncheck, "./..."],
                900,
                module_root,
            )
            for module_root in GO_MODULE_ROOTS
        ],
        ("security:local-strict", [npm, "run", "security:local-strict"], 900, REPO_ROOT),
        ("build:ui", [npm, "run", "build:ui"], 900, REPO_ROOT),
        ("build:host", [npm, "run", "build:host"], 1200, REPO_ROOT),
        ("smoke:playwright-all", [npm, "run", "smoke:playwright-all"], 1200, REPO_ROOT),
        ("ci", [npm, "run", "ci"], 1800, REPO_ROOT),
        ("cargo:test", [cargo, "test", "--locked"], 1200, TAURI_ROOT),
    ]
    if os.name == "nt":
        steps.append((
            "cargo:tauri-build",
            [cargo, "tauri", "build", "--ci", "--bundles", "nsis", "--no-sign", "--", "--locked"],
            2700,
            TAURI_ROOT,
        ))
    return steps


def main() -> int:
    parser = argparse.ArgumentParser(description="Run Agent Cowork quality gates.")
    parser.add_argument("--level", choices=["quick", "full"], default="quick")
    args = parser.parse_args()

    env = os.environ.copy()
    env["CI"] = "1"
    env["PYTHONUTF8"] = "1"
    env["GOTOOLCHAIN"] = "local"
    env["GOFLAGS"] = "-mod=readonly"

    try:
        npm = npm_command()
        cargo = cargo_command() if args.level == "full" else None
        cargo_audit = None
        govulncheck = None
        pip_audit = None
        if args.level == "full":
            go = go_command()
            path_key = next((key for key in env if key.upper() == "PATH"), "PATH")
            env[path_key] = os.pathsep.join((str(Path(go).parent), env.get(path_key, "")))
            cargo_audit = cargo_audit_command()
            govulncheck = govulncheck_command()
            pip_audit = pip_audit_command()
            verify_pinned_audit_tools(
                npm,
                cargo,
                cargo_audit,
                go,
                govulncheck,
                pip_audit,
                env,
            )
            replay_path = resolve_replay_records(env)
            print(f"[quality-gate] eval replay records: {replay_path}", flush=True)
        run_gate_steps(
            build_steps(
                args.level,
                npm,
                cargo,
                cargo_audit,
                govulncheck,
                pip_audit,
            ),
            env,
        )
    except GateError as error:
        print(f"[quality-gate] failed: {error}", file=sys.stderr, flush=True)
        return 1

    if args.level == "full":
        print("\n[quality-gate] full local source gate passed", flush=True)
        print(
            "[quality-gate] external release acceptance remains required: "
            "installed client smoke, trusted signing verification, and production updater verification.",
            flush=True,
        )
    else:
        print("\n[quality-gate] quick local source gate passed", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
