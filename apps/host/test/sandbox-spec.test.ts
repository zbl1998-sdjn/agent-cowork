import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';

test('normalizeSandboxSpec applies safe defaults for a valid spec', () => {
  const spec = normalizeSandboxSpec({ tool: 'node', args: ['-e', 'process.stdout.write("a b")'] });
  assert.equal(spec.tool, 'node');
  assert.deepEqual(spec.args, ['-e', 'process.stdout.write("a b")']);
  assert.equal(spec.network, false, 'network defaults off');
  assert.equal(spec.workspaceWrite, false, 'workspace mount defaults read-only');
  assert.ok(spec.timeoutMs > 0);
  assert.ok(spec.maxOutputBytes > 0);
});

test('normalizeSandboxSpec grants workspace writes only for an explicit true capability', () => {
  assert.throws(
    () => normalizeSandboxSpec({ tool: 'node', workspaceWrite: true }),
    /workspaceWrite requires an explicit capability/,
  );
  assert.equal(
    normalizeSandboxSpec({ tool: 'node', workspaceWrite: true }, { allowWorkspaceWrite: true }).workspaceWrite,
    true,
  );
  assert.equal(normalizeSandboxSpec({ tool: 'node', workspaceWrite: false }).workspaceWrite, false);
  assert.throws(
    () => normalizeSandboxSpec({ tool: 'node', workspaceWrite: 'true' }),
    /workspaceWrite must be a boolean/,
  );
});

test('normalizeSandboxSpec rejects unsafe / malformed specs', () => {
  assert.throws(() => normalizeSandboxSpec({}), /tool is required/);
  assert.throws(() => normalizeSandboxSpec({ tool: '/usr/bin/node' }), /bare command name/);
  assert.throws(() => normalizeSandboxSpec({ tool: 'node; rm -rf' }), /bare command name/);
  assert.throws(() => normalizeSandboxSpec({ tool: 'node', args: 'oops' }), /args must be an array/);
  assert.throws(() => normalizeSandboxSpec({ tool: 'node', timeoutMs: -1 }), /positive number/);
});

test('normalizeSandboxSpec enforces the tool allowlist when provided', () => {
  assert.throws(
    () => normalizeSandboxSpec({ tool: 'curl' }, { allowTools: ['node', 'python3'] }),
    /not in the allowlist/,
  );
  const ok = normalizeSandboxSpec({ tool: 'node' }, { allowTools: ['node'] });
  assert.equal(ok.tool, 'node');
});

test('normalizeSandboxSpec clamps timeout to the configured maximum', () => {
  const spec = normalizeSandboxSpec({ tool: 'node', timeoutMs: 9_999_999 }, { maxTimeoutMs: 5000 });
  assert.equal(spec.timeoutMs, 5000);
});

test('normalizeSandboxSpec rejects non-allowlisted env keys', () => {
  assert.throws(
    () => normalizeSandboxSpec({ tool: 'node', env: { SECRET: 'x' } }, { allowEnv: ['LANG'] }),
    /not in the allowlist/,
  );
  const ok = normalizeSandboxSpec({ tool: 'node', env: { LANG: 'C' } }, { allowEnv: ['LANG'] });
  assert.deepEqual(ok.env, { LANG: 'C' });
});
