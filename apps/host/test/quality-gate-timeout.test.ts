import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const qualityGatePath = path.join(repoRoot, 'scripts', 'quality_gate.py');

test('quality gate runner isolates process trees without a command shell', () => {
  const source = fs.readFileSync(
    path.join(repoRoot, 'scripts', 'quality_gate_process.py'),
    'utf8',
  );
  assert.match(source, /CREATE_NEW_PROCESS_GROUP/);
  assert.match(source, /"taskkill\.exe"/);
  assert.match(source, /"\/T", "\/F"/);
  assert.match(source, /"start_new_session"/);
  assert.match(source, /os\.killpg/);
  assert.match(source, /"shell": False/);
  assert.doesNotMatch(source, /shell\s*=\s*True/);
});

test('quality gate timeout terminates descendant processes and preserves diagnostics', () => {
  const harness = String.raw`
import ctypes
import importlib.util
import os
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

spec = importlib.util.spec_from_file_location("agent_cowork_quality_gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(gate)

PARENT = r'''
import subprocess
import sys
import time
from pathlib import Path

child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
Path(sys.argv[1]).write_text(str(child.pid), encoding="utf-8")
print("parent-ready", flush=True)
print("parent-stderr", file=sys.stderr, flush=True)
time.sleep(60)
'''

def process_alive(pid):
    if os.name == "nt":
        handle = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            exit_code = ctypes.c_ulong()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code))
            return bool(ok) and exit_code.value == 259
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False

def cleanup(pid):
    if not process_alive(pid):
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(pid), "/T", "/F"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    else:
        os.kill(pid, signal.SIGKILL)

def exercise(label, runner, root):
    pid_path = root / f"{label}.pid"
    command = [sys.executable, "-c", PARENT, str(pid_path)]
    try:
        runner(command)
    except gate.GateError as error:
        message = str(error)
        assert "timed out" in message, message
        if label == "parallel":
            assert "parent-ready" in message, message
            assert "parent-stderr" in message, message
    else:
        raise AssertionError(f"{label} timeout must fail closed")

    deadline = time.monotonic() + 2
    while not pid_path.exists() and time.monotonic() < deadline:
        time.sleep(0.02)
    assert pid_path.exists(), f"{label} parent did not publish the descendant pid"
    pid = int(pid_path.read_text(encoding="utf-8"))
    deadline = time.monotonic() + 5
    while process_alive(pid) and time.monotonic() < deadline:
        time.sleep(0.05)
    alive = process_alive(pid)
    if alive:
        cleanup(pid)
    assert not alive, f"{label} left descendant process {pid} alive"

with tempfile.TemporaryDirectory(prefix="kcw-quality-gate-timeout-") as temp_dir:
    root = Path(temp_dir)
    env = os.environ.copy()
    exercise(
        "sequential",
        lambda command: gate.run_step("timeout-tree", command, env, 1, root),
        root,
    )
    exercise(
        "parallel",
        lambda command: gate.run_parallel_steps(
            [("govulncheck:timeout-tree", command, 1, root)], env, 1
        ),
        root,
    )
`;
  const result = spawnSync('python', ['-X', 'utf8', '-c', harness, qualityGatePath], {
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
  assert.match(String(result.stdout), /parent-ready/);
  assert.match(String(result.stderr), /parent-stderr/);
});

test('release evidence workflow leaves bounded headroom around the full gate', () => {
  const workflow = fs.readFileSync(
    path.join(repoRoot, '.github', 'workflows', 'release-evidence.yml'),
    'utf8',
  );
  const jobMatch = /attest-unsigned-source-build:[\s\S]*?runs-on: windows-2025\s+timeout-minutes: (\d+)/.exec(workflow);
  assert.ok(jobMatch?.[1], 'release evidence job timeout must be explicit');

  const gateStart = workflow.indexOf('      - name: Run the full local-source quality gate');
  const gateEnd = workflow.indexOf('\n      - name:', gateStart + 1);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, 'full gate step must be present');
  const gateBlock = workflow.slice(gateStart, gateEnd);
  const stepMatch = /timeout-minutes: (\d+)/.exec(gateBlock);
  assert.ok(stepMatch?.[1], 'full gate step timeout must be explicit');

  const jobMinutes = Number(jobMatch[1]);
  const stepMinutes = Number(stepMatch[1]);
  assert.equal(jobMinutes, 180);
  assert.equal(stepMinutes, 120);
  assert.ok(jobMinutes >= stepMinutes + 60, 'job must reserve bounded setup and evidence headroom');
});
