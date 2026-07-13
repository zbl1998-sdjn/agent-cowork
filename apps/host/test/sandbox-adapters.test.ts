import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createSandbox } from '../src/sandbox/index.js';
import { LocalSubprocessSandbox } from '../src/sandbox/local-sandbox.js';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { VmSandbox } from '../src/sandbox/vm-sandbox.js';
import { tempRoot } from './helpers/host-http.js';
import { fakeSpawn } from './helpers/sandbox.js';
import type { CapturedSpawn } from './helpers/sandbox.js';

const unrestrictedLimits = { allowUnrestrictedHostExecution: true } as const;

test('LocalSubprocessSandbox rejects host execution by default before spawning', async () => {
  const captured: CapturedSpawn = {};
  const sandbox = new LocalSubprocessSandbox({ spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec({ tool: 'node' });
  await assert.rejects(
    () => sandbox.exec(spec, { trustedRoot: tempRoot('kcw-sbx-') }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /cannot enforce workspace or host isolation/);
      assert.equal((error as Error & { statusCode?: number }).statusCode, 501);
      return true;
    },
  );
  assert.equal(captured.command, undefined);
});

test('LocalSubprocessSandbox runs a tool and captures stdout + exit code only with explicit unrestricted capability', async () => {
  const root = tempRoot('kcw-sbx-');
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec(
    { tool: 'node', args: ['-e', 'process.stdout.write("hello")'], timeoutMs: 5000, unrestrictedHostExecution: true },
    unrestrictedLimits,
  );
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.timedOut, false);
  assert.equal(result.networkIsolated, false);
  assert.ok(result.warnings.some((warning) => /network isolation/.test(warning)));
  assert.ok(result.warnings.some((warning) => /not a read-only or OS-isolated sandbox/.test(warning)));
});

test('LocalSubprocessSandbox enforces the timeout', async () => {
  const root = tempRoot('kcw-sbx-');
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec(
    { tool: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 300, unrestrictedHostExecution: true },
    unrestrictedLimits,
  );
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.timedOut, true);
});

test('LocalSubprocessSandbox caps output and flags truncation', async () => {
  const root = tempRoot('kcw-sbx-');
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec(
    {
      tool: 'node',
      args: ['-e', 'process.stdout.write("x".repeat(5000))'],
      timeoutMs: 5000,
      unrestrictedHostExecution: true,
    },
    { ...unrestrictedLimits, defaultMaxOutputBytes: 100 },
  );
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 100);
});

test('LocalSubprocessSandbox requires a trusted root', async () => {
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec(
    { tool: 'node', args: ['-e', ''], timeoutMs: 1000, unrestrictedHostExecution: true },
    unrestrictedLimits,
  );
  await assert.rejects(() => sandbox.exec(spec, {}), /trustedRoot is required/);
});

test('LocalSubprocessSandbox uses a validated trusted absolute executable path', async () => {
  const captured: CapturedSpawn = {};
  const sandbox = new LocalSubprocessSandbox({ spawn: fakeSpawn(captured) });
  const executablePath = fs.realpathSync(process.execPath);
  const spec = normalizeSandboxSpec(
    { tool: path.basename(executablePath), unrestrictedHostExecution: true },
    unrestrictedLimits,
  );
  const internalSpec = { ...spec, executablePath };
  await sandbox.exec(internalSpec, { trustedRoot: tempRoot('kcw-sbx-') });
  assert.equal(captured.command, executablePath);
});

test('LocalSubprocessSandbox rejects invalid or non-file internal executable paths before spawning', async () => {
  const root = tempRoot('kcw-sbx-');
  const missing = path.resolve(root, 'missing', 'node');
  const directory = path.resolve(root, 'directory', 'node');
  fs.mkdirSync(directory, { recursive: true });
  for (const executablePath of ['relative/node', `bad${String.fromCharCode(0)}node`, path.resolve(root, 'python'), missing, directory]) {
    const captured: CapturedSpawn = {};
    const sandbox = new LocalSubprocessSandbox({ spawn: fakeSpawn(captured) });
    const spec = normalizeSandboxSpec(
      { tool: 'node', unrestrictedHostExecution: true },
      unrestrictedLimits,
    );
    await assert.rejects(() => sandbox.exec({ ...spec, executablePath }, { trustedRoot: root }), /executablePath/);
    assert.equal(captured.command, undefined);
  }
});

test('LocalSubprocessSandbox rejects an executable whose realpath basename changes', async (t) => {
  const root = tempRoot('kcw-sbx-');
  const linkPath = path.join(root, process.platform === 'win32' ? 'trusted-node.exe' : 'trusted-node');
  try {
    fs.symlinkSync(process.execPath, linkPath, 'file');
  } catch (error) {
    t.skip(`file symlink unavailable: ${String(error)}`);
    return;
  }
  const captured: CapturedSpawn = {};
  const sandbox = new LocalSubprocessSandbox({ spawn: fakeSpawn(captured) });
  const spec = normalizeSandboxSpec(
    { tool: path.basename(linkPath), unrestrictedHostExecution: true },
    unrestrictedLimits,
  );
  await assert.rejects(
    () => sandbox.exec({ ...spec, executablePath: linkPath }, { trustedRoot: root }),
    /realpath basename must match tool/,
  );
  assert.equal(captured.command, undefined);
});

test('VmSandbox fails fast (501) when not provisioned, but can plan', () => {
  const sandbox = createSandbox({ backend: 'docker' });
  assert.ok(sandbox instanceof VmSandbox);
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 1000 });
  const plan = sandbox.plan(spec, { trustedRoot: '/work/root' });
  assert.ok(plan, 'docker sandbox should build a plan');
  assert.ok(plan.argv.includes('--network=none'), 'docker plan defaults to no network');
  assert.ok(plan.argv.includes('--read-only'), 'docker plan has a read-only root filesystem');
  assert.ok(plan.argv.includes('--cap-drop=ALL'), 'docker plan drops all capabilities');
  assert.ok(plan.argv.includes('--security-opt=no-new-privileges=true'), 'docker plan blocks privilege escalation');
  assert.match(plan.argv.find((arg) => arg.startsWith('--user=')) || '', /^--user=[1-9][0-9]*:[1-9][0-9]*$/, 'docker plan uses a non-root user');
  assert.ok(plan.argv.includes('--pids-limit=128'), 'docker plan bounds processes');
  assert.ok(plan.argv.includes('--memory=512m'), 'docker plan bounds memory');
  assert.ok(plan.argv.includes('--cpus=1'), 'docker plan bounds CPU');
  assert.ok(plan.argv.includes('/work/root:/work:ro'), 'docker plan mounts the workspace read-only by default');
  assert.equal(plan.networkIsolated, true);
});

test('VmSandbox.exec rejects with 501 until a runner is injected', async () => {
  const sandbox = new VmSandbox({ backend: 'docker' });
  const spec = normalizeSandboxSpec({ tool: 'python3', timeoutMs: 1000 });
  await assert.rejects(() => sandbox.exec(spec, { trustedRoot: tempRoot('kcw-sbx-') }), /not provisioned/);
});
