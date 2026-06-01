import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandbox } from '../src/sandbox/index.js';
import { LocalSubprocessSandbox } from '../src/sandbox/local-sandbox.js';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { VmSandbox } from '../src/sandbox/vm-sandbox.js';
import { tempRoot } from './helpers/host-http.js';

test('LocalSubprocessSandbox runs a tool and captures stdout + exit code', async () => {
  const root = tempRoot('kcw-sbx-');
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', 'process.stdout.write("hello")'], timeoutMs: 5000 });
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.timedOut, false);
  assert.equal(result.networkIsolated, false);
  assert.ok(result.warnings.some((warning) => /network isolation/.test(warning)));
});

test('LocalSubprocessSandbox enforces the timeout', async () => {
  const root = tempRoot('kcw-sbx-');
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', 'setTimeout(() => {}, 10000)'], timeoutMs: 300 });
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.timedOut, true);
});

test('LocalSubprocessSandbox caps output and flags truncation', async () => {
  const root = tempRoot('kcw-sbx-');
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec(
    { tool: 'node', args: ['-e', 'process.stdout.write("x".repeat(5000))'], timeoutMs: 5000 },
    { defaultMaxOutputBytes: 100 },
  );
  const result = await sandbox.exec(spec, { trustedRoot: root });
  assert.equal(result.truncated, true);
  assert.equal(result.stdout.length, 100);
});

test('LocalSubprocessSandbox requires a trusted root', async () => {
  const sandbox = new LocalSubprocessSandbox();
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', ''], timeoutMs: 1000 });
  await assert.rejects(() => sandbox.exec(spec, {}), /trustedRoot is required/);
});

test('VmSandbox fails fast (501) when not provisioned, but can plan', () => {
  const sandbox = createSandbox({ backend: 'docker' });
  assert.ok(sandbox instanceof VmSandbox);
  const spec = normalizeSandboxSpec({ tool: 'python3', args: ['-c', 'print(1)'], timeoutMs: 1000 });
  const plan = sandbox.plan(spec, { trustedRoot: '/work/root' });
  assert.ok(plan, 'docker sandbox should build a plan');
  assert.ok(plan.argv.includes('--network=none'), 'docker plan defaults to no network');
  assert.equal(plan.networkIsolated, true);
});

test('VmSandbox.exec rejects with 501 until a runner is injected', async () => {
  const sandbox = new VmSandbox({ backend: 'docker' });
  const spec = normalizeSandboxSpec({ tool: 'python3', timeoutMs: 1000 });
  await assert.rejects(() => sandbox.exec(spec, { trustedRoot: tempRoot('kcw-sbx-') }), /not provisioned/);
});
