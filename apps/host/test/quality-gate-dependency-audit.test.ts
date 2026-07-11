import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('full quality gate plans npm, Rust, Go, and embedded Python audits', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'quality_gate.py'), 'utf8');
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  assert.match(source, /"npm": "10\.9\.8"/);
  assert.match(source, /"cargo-audit": "0\.22\.2"/);
  assert.match(source, /"govulncheck": "v1\.6\.0"/);
  assert.match(source, /"pip-audit": "2\.10\.1"/);
  assert.match(source, /"--audit-level=high"/);
  assert.match(source, /"--registry=https:\/\/registry\.npmjs\.org"/);
  assert.match(source, /\("npm:audit-root", \[npm, \*NPM_AUDIT_ARGS\]/);
  assert.match(source, /\("npm:audit-ui", \[npm, \*NPM_AUDIT_ARGS\]/);
  assert.match(source, /cargo_audit = cargo_audit_command\(\)/);
  assert.match(
    source,
    /"cargo:audit"[\s\S]*?\[cargo_audit, "audit", "--deny", "unsound", "--ignore", "RUSTSEC-2024-0429"\]/,
  );
  assert.doesNotMatch(source, /\[cargo, "audit"/);
  assert.match(source, /verify_ignored_rust_advisories_not_in_shipping_target/);
  assert.match(source, /"--filter-platform"/);
  assert.match(source, /WINDOWS_RELEASE_TARGET = "x86_64-pc-windows-msvc"/);
  assert.match(source, /\[govulncheck, "\.\/\.\.\."\]/);
  assert.match(source, /"--require-hashes"/);
  assert.doesNotMatch(source, /"--no-deps"/);
  assert.match(source, /"--disable-pip"/);
  assert.match(source, /"--strict"/);
  assert.match(source, /python-packages\.lock/);
  assert.match(source, /python-bootstrap\.lock/);
  for (const modulePath of [
    '"apps" / "local-agent"',
    '"services" / "api"',
    '"services" / "relay"',
    '"services" / "orchestrator"',
    '"services" / "kimi-gateway"',
  ]) {
    assert.ok(source.includes(modulePath), modulePath);
  }
  assert.match(source, /env\["GOTOOLCHAIN"\] = "local"/);
  assert.match(source, /env\["GOFLAGS"\] = "-mod=readonly"/);
  assert.match(source, /cargo_audit_command\(\)/);
  assert.match(source, /govulncheck_command\(\)/);
  assert.match(source, /pip_audit_command\(\)/);
  assert.doesNotMatch(workflow, /\bnpm install(?:\s|$)/m);
  assert.match(workflow, /test "\$\(npm --version\)" = "10\.9\.8"/);
  assert.match(workflow, /pip-audit==2\.10\.1/);
  assert.match(workflow, /python-packages\.lock/);
  assert.match(workflow, /python-bootstrap\.lock/);
  assert.match(workflow, /--require-hashes/);
  assert.doesNotMatch(workflow, /--no-deps/);
  assert.match(workflow, /--disable-pip/);

  const installStep = workflow.indexOf('      - name: Install the pinned Python vulnerability auditor');
  const pathVerifyStep = workflow.indexOf('      - name: Verify the pinned Python vulnerability auditor on PATH');
  const auditStep = workflow.indexOf('      - name: Audit the hash-locked embedded Python runtime');
  assert.ok(installStep >= 0, 'CI must install the pinned Python auditor');
  assert.ok(pathVerifyStep > installStep, 'PATH verification must be a later, independent step');
  assert.ok(auditStep > pathVerifyStep, 'the dependency audit must run after PATH verification');

  const installBody = workflow.slice(installStep, pathVerifyStep);
  assert.match(installBody, /echo "\$RUNNER_TEMP\/pip-audit-2\.10\.1\/bin" >> "\$GITHUB_PATH"/);
  const pathVerifyBody = workflow.slice(pathVerifyStep, auditStep);
  assert.match(pathVerifyBody, /command -v pip-audit/);
  assert.match(pathVerifyBody, /test "\$\(pip-audit --version\)" = "pip-audit 2\.10\.1"/);
  assert.doesNotMatch(pathVerifyBody, /RUNNER_TEMP/, 'version verification must resolve pip-audit from PATH');
});

test('embedded Python audit fails closed with a pinned fake auditor', () => {
  const qualityGatePath = path.join(repoRoot, 'scripts', 'quality_gate.py');
  const harness = String.raw`
import importlib.util
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("agent_cowork_quality_gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(gate)

def expect_gate_error(action, label):
    try:
        action()
    except gate.GateError:
        return
    raise AssertionError(label)

with patch.object(gate.shutil, "which", return_value=None):
    expect_gate_error(gate.pip_audit_command, "missing pip-audit must fail closed")

original_runtime_lock = gate.EMBEDDED_PYTHON_REQUIREMENTS_LOCK
original_bootstrap_lock = gate.EMBEDDED_PYTHON_BOOTSTRAP_LOCK
with tempfile.TemporaryDirectory(prefix="kcw-fake-pip-audit-") as temp_dir:
    temp_root = Path(temp_dir)
    fake_audit = temp_root / "fake_pip_audit.py"
    fake_audit.write_text(
        """import os, sys
if '--version' in sys.argv:
    print('pip-audit ' + os.environ.get('FAKE_PIP_AUDIT_VERSION', '2.10.1'))
    raise SystemExit(0)
required = {'--require-hashes', '--disable-pip', '--strict'}
if not required.issubset(set(sys.argv[1:])):
    raise SystemExit(7)
if os.environ.get('FAKE_PIP_AUDIT_VULNERABLE') == '1':
    print('fake vulnerability found')
    raise SystemExit(1)
raise SystemExit(0)
""",
        encoding="utf-8",
    )
    fake_command = [sys.executable, str(fake_audit)]
    env = os.environ.copy()

    mismatch_env = env.copy()
    mismatch_env['FAKE_PIP_AUDIT_VERSION'] = '2.10.0'
    expect_gate_error(
        lambda: gate.verify_pip_audit_tool(fake_command, mismatch_env),
        "wrong pip-audit version must fail closed",
    )
    gate.verify_pip_audit_tool(fake_command, env)

    gate.EMBEDDED_PYTHON_REQUIREMENTS_LOCK = temp_root / 'missing.lock'
    expect_gate_error(
        lambda: gate.embedded_python_audit_steps(fake_command),
        "missing embedded Python runtime lock must fail closed",
    )
    gate.EMBEDDED_PYTHON_REQUIREMENTS_LOCK = original_runtime_lock

    gate.EMBEDDED_PYTHON_BOOTSTRAP_LOCK = temp_root / 'missing-bootstrap.lock'
    expect_gate_error(
        lambda: gate.embedded_python_audit_steps(fake_command),
        "missing pip bootstrap lock must fail closed",
    )
    gate.EMBEDDED_PYTHON_BOOTSTRAP_LOCK = original_bootstrap_lock

    audit_steps = gate.embedded_python_audit_steps(fake_command)
    assert len(audit_steps) == 2
    audited_locks = set()
    for name, command, timeout_sec, cwd in audit_steps:
        requirement_index = command.index('--requirement')
        audited_locks.add(command[requirement_index + 1])
        assert '--no-deps' not in command
        gate.run_step(name, command, env, min(timeout_sec, 5), cwd)
    assert audited_locks == {str(original_runtime_lock), str(original_bootstrap_lock)}

    name, command, _, cwd = audit_steps[0]
    vulnerable_env = env.copy()
    vulnerable_env['FAKE_PIP_AUDIT_VULNERABLE'] = '1'
    expect_gate_error(
        lambda: gate.run_step(name, command, vulnerable_env, 5, cwd),
        "reported vulnerability must fail closed",
    )
`;
  const result = spawnSync('python', ['-X', 'utf8', '-c', harness, qualityGatePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
});

test('ignored Rust advisory is allowed only outside the Windows release graph', () => {
  const qualityGatePath = path.join(repoRoot, 'scripts', 'quality_gate.py');
  const harness = String.raw`
import importlib.util
import json
import os
import sys
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("agent_cowork_quality_gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(gate)

def metadata(package_names):
    packages = [
        {"id": f"registry+test#{name}@1.0.0", "name": name}
        for name in package_names
    ]
    return json.dumps({
        "packages": packages,
        "resolve": {"nodes": [{"id": item["id"]} for item in packages]},
    })

with patch.object(gate, "command_output", return_value=metadata(["anyhow", "tauri"])):
    gate.verify_ignored_rust_advisories_not_in_shipping_target("cargo", os.environ.copy())

with patch.object(gate, "command_output", return_value=metadata(["glib", "tauri"])):
    try:
        gate.verify_ignored_rust_advisories_not_in_shipping_target("cargo", os.environ.copy())
    except gate.GateError as error:
        assert "glib" in str(error)
    else:
        raise AssertionError("ignored glib advisory must fail when glib enters the Windows graph")
`;
  const result = spawnSync('python', ['-X', 'utf8', '-c', harness, qualityGatePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
});

test('quality gate prefers the side-by-side pinned Go toolchain', () => {
  const qualityGatePath = path.join(repoRoot, 'scripts', 'quality_gate.py');
  const harness = String.raw`
import importlib.util
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("agent_cowork_quality_gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(gate)

with tempfile.TemporaryDirectory(prefix="kcw-pinned-go-") as temp_dir:
    pinned_go = Path(temp_dir) / "go.exe"
    pinned_go.write_bytes(b"test")
    gate.PINNED_GO_TOOLCHAIN = pinned_go
    with patch.object(gate.shutil, "which", return_value="system-go.exe"):
        assert gate.go_command() == str(pinned_go)

gate.PINNED_GO_TOOLCHAIN = Path(temp_dir) / "missing-go.exe"
with patch.object(gate.shutil, "which", return_value="system-go.exe"):
    assert gate.go_command() == "system-go.exe"
`;
  const result = spawnSync('python', ['-X', 'utf8', '-c', harness, qualityGatePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
});

test('quality gate runs every Go audit with bounded fail-closed parallelism', () => {
  const qualityGatePath = path.join(repoRoot, 'scripts', 'quality_gate.py');
  const harness = String.raw`
import importlib.util
import os
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("agent_cowork_quality_gate", sys.argv[1])
gate = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(gate)

steps = [
    (f"govulncheck:module-{index}", ["govulncheck", "./..."], 5, Path(f"module-{index}"))
    for index in range(5)
]
steps.append(("after-audits", ["noop"], 5, Path("after")))

lock = threading.Lock()
active = 0
max_active = 0
called = []

def fake_run(command, *, cwd, env, text, encoding, errors, timeout, check, capture_output=False):
    global active, max_active
    name = str(cwd)
    with lock:
        called.append(name)
        active += 1
        max_active = max(max_active, active)
    time.sleep(0.03)
    with lock:
        active -= 1
    return SimpleNamespace(returncode=0, stdout=f"ok:{name}\n", stderr="")

env = os.environ.copy()
env["KCW_GOVULNCHECK_CONCURRENCY"] = "3"
with patch.object(gate, "run_process", side_effect=fake_run):
    gate.run_gate_steps(steps, env)

assert max_active == 3, max_active
assert sorted(called[:5]) == [f"module-{index}" for index in range(5)]
assert called[-1] == "after"

def failing_run(command, *, cwd, env, text, encoding, errors, timeout, check, capture_output=False):
    name = str(cwd)
    return SimpleNamespace(
        returncode=7 if name == "module-2" else 0,
        stdout="",
        stderr="fake vulnerability" if name == "module-2" else "",
    )

with patch.object(gate, "run_process", side_effect=failing_run):
    try:
        gate.run_gate_steps(steps[:-1], env)
    except gate.GateError as error:
        assert "module-2" in str(error)
    else:
        raise AssertionError("one failed Go audit must fail the parallel group")

bad_env = os.environ.copy()
bad_env["KCW_GOVULNCHECK_CONCURRENCY"] = "0"
try:
    gate.run_gate_steps(steps[:-1], bad_env)
except gate.GateError as error:
    assert "KCW_GOVULNCHECK_CONCURRENCY" in str(error)
else:
    raise AssertionError("invalid parallelism must fail closed")
`;
  const result = spawnSync('python', ['-X', 'utf8', '-c', harness, qualityGatePath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, String(result.stdout) + String(result.stderr));
});

test('architecture baseline documents the current Go CI security boundary', () => {
  const baseline = fs.readFileSync(path.join(repoRoot, 'plan', '00-架构基线与模块依赖.md'), 'utf8');

  assert.doesNotMatch(baseline, /Go\)当前定位:预研骨架,\*\*不参与构建\/CI\*\*/);
  assert.doesNotMatch(baseline, /\.github\/workflows\/ci\.yml` 无 `setup-go`/);
  assert.match(baseline, /actions\/setup-go/);
  assert.match(baseline, /govulncheck/);
  assert.match(baseline, /不进入产品打包\/发布/);
});
