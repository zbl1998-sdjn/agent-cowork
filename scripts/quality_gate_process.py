"""Bounded subprocess execution for the repository quality gate.

Every command starts in an isolated process group. Timeouts terminate the
whole group/tree before the direct child is reaped, so gate cancellation does
not leave audit, build, or test descendants running in the background.
"""
from __future__ import annotations

import os
import signal
import subprocess
import time
from pathlib import Path
from typing import Mapping, Sequence


class ProcessTreeTimeout(TimeoutError):
    """Raised after a timed-out process tree has been terminated and reaped."""

    def __init__(
        self,
        command: Sequence[str],
        timeout: float,
        stdout: str | None,
        stderr: str | None,
        cleanup_error: str | None,
    ) -> None:
        super().__init__(f"process timed out after {timeout}s: {' '.join(command)}")
        self.stdout = stdout
        self.stderr = stderr
        self.cleanup_error = cleanup_error

    def diagnostics(self, *, streamed: bool) -> str:
        details: list[str] = []
        if self.stdout:
            details.append(f"stdout: {self.stdout.strip()}")
        if self.stderr:
            details.append(f"stderr: {self.stderr.strip()}")
        if streamed and not self.stdout and not self.stderr:
            details.append("stdout/stderr were streamed to the parent process")
        if self.cleanup_error:
            details.append(f"cleanup error: {self.cleanup_error}")
        return "; ".join(details)


def _taskkill_path() -> str:
    system_root = os.environ.get("SystemRoot", "").strip()
    if system_root:
        candidate = Path(system_root) / "System32" / "taskkill.exe"
        if candidate.is_file():
            return str(candidate)
    return "taskkill.exe"


def _terminate_windows_tree(process: subprocess.Popen[str]) -> str | None:
    command = [_taskkill_path(), "/PID", str(process.pid), "/T", "/F"]
    try:
        killer = subprocess.Popen(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            shell=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as exc:
        return f"could not start taskkill for PID {process.pid}: {exc}"
    try:
        stdout, stderr = killer.communicate(timeout=15)
    except subprocess.TimeoutExpired:
        killer.kill()
        stdout, stderr = killer.communicate()
        return f"taskkill timed out for PID {process.pid}: {(stderr or stdout).strip()}"
    if killer.returncode != 0 and process.poll() is None:
        detail = (stderr or stdout).strip()
        return f"taskkill failed for PID {process.pid} with exit code {killer.returncode}: {detail}"
    return None


def _process_group_exists(process_group_id: int) -> bool:
    try:
        os.killpg(process_group_id, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _terminate_posix_group(process: subprocess.Popen[str]) -> str | None:
    process_group_id = process.pid
    try:
        os.killpg(process_group_id, signal.SIGTERM)
    except ProcessLookupError:
        return None
    except OSError as exc:
        return f"could not terminate process group {process_group_id}: {exc}"

    deadline = time.monotonic() + 2
    while _process_group_exists(process_group_id) and time.monotonic() < deadline:
        time.sleep(0.05)
    if not _process_group_exists(process_group_id):
        return None
    try:
        os.killpg(process_group_id, signal.SIGKILL)
    except ProcessLookupError:
        return None
    except OSError as exc:
        return f"could not kill process group {process_group_id}: {exc}"
    return None


def _terminate_process_tree(process: subprocess.Popen[str]) -> str | None:
    if os.name == "nt":
        error = _terminate_windows_tree(process)
    else:
        error = _terminate_posix_group(process)
    if process.poll() is None and error:
        try:
            process.kill()
        except OSError as exc:
            return f"{error}; direct child kill also failed: {exc}"
    return error


def _reap_process(
    process: subprocess.Popen[str],
    timeout: float,
) -> tuple[str | None, str | None, str | None]:
    try:
        stdout, stderr = process.communicate(timeout=timeout)
        return stdout, stderr, None
    except subprocess.TimeoutExpired:
        if process.poll() is None:
            process.kill()
        try:
            stdout, stderr = process.communicate(timeout=5)
            return stdout, stderr, "direct child required a fallback kill during reap"
        except subprocess.TimeoutExpired:
            for stream in (process.stdout, process.stderr):
                if stream is not None:
                    stream.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                return None, None, "direct child could not be reaped after tree termination"
            return None, None, "captured output pipes remained open after tree termination"


def run_process(
    command: Sequence[str],
    *,
    cwd: Path,
    env: Mapping[str, str],
    text: bool,
    encoding: str,
    errors: str,
    timeout: float,
    check: bool,
    capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    """Run one command without a shell and tear down its process tree on timeout."""
    if not text:
        raise ValueError("quality gate subprocesses must use text mode")
    popen_options: dict[str, object] = {
        "cwd": cwd,
        "env": env,
        "text": True,
        "encoding": encoding,
        "errors": errors,
        "shell": False,
    }
    if capture_output:
        popen_options.update(stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if os.name == "nt":
        popen_options["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    else:
        popen_options["start_new_session"] = True

    process = subprocess.Popen(list(command), **popen_options)  # type: ignore[arg-type]
    try:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            cleanup_error = _terminate_process_tree(process)
            stdout, stderr, reap_error = _reap_process(process, 10)
            if reap_error:
                cleanup_error = f"{cleanup_error}; {reap_error}" if cleanup_error else reap_error
            raise ProcessTreeTimeout(command, timeout, stdout, stderr, cleanup_error) from exc

        completed = subprocess.CompletedProcess(list(command), process.returncode, stdout, stderr)
        if check and completed.returncode != 0:
            raise subprocess.CalledProcessError(
                completed.returncode,
                completed.args,
                output=completed.stdout,
                stderr=completed.stderr,
            )
        return completed
    finally:
        if process.poll() is None:
            _terminate_process_tree(process)
            _reap_process(process, 10)
