import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_ALLOW_TOOLS } from '../src/sandbox/index.js';
import { runCode } from '../src/sandbox/code-runner.js';
import type { SandboxLike } from '../src/sandbox/code-runner.js';
import type { SandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { present, tempRoot } from './helpers/host-http.js';

type CapturingSandbox = SandboxLike & { capturedSpec: SandboxSpec | null };

const sandboxAllowTools = (): string[] => [...DEFAULT_ALLOW_TOOLS];

function makeCapturingSandbox(backend: string): CapturingSandbox {
  return {
    backend,
    capturedSpec: null,
    exec: async function exec(spec: SandboxSpec) {
      this.capturedSpec = spec;
      return {
        backend,
        exitCode: 0,
        timedOut: false,
        stdout: 'ok',
        stderr: '',
        durationMs: 1,
      };
    },
  };
}

test('runCode prefers configured embedded Python on the local backend', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const embeddedPython = path.join(trustedRoot, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python');
  const sandbox = makeCapturingSandbox('local-subprocess');

  const outcome = await runCode({
    sandbox,
    sandboxLimits: { allowTools: sandboxAllowTools() },
    runtimeEnv: { KCW_EMBEDDED_PYTHON: embeddedPython },
    tool: 'python3',
    code: 'print("ok")',
    trustedRoot,
    runStoreRoot: path.join(trustedRoot, 'runs'),
  });

  const spec = present(sandbox.capturedSpec, 'captured python spec');
  assert.equal(spec.tool, path.basename(embeddedPython));
  assert.deepEqual(spec.args, [outcome.scriptRelative]);
  assert.equal(spec.env.PATH, path.dirname(embeddedPython));
  assert.match(outcome.scriptRelative, /^\.AgentCowork\/scripts\/run_[^/]+\.py$/);
});

test('runCode keeps VM Python tools inside the VM image', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const embeddedPython = path.join(trustedRoot, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python');
  const sandbox = makeCapturingSandbox('vm:docker');

  await runCode({
    sandbox,
    sandboxLimits: { allowTools: sandboxAllowTools() },
    runtimeEnv: { KCW_EMBEDDED_PYTHON: embeddedPython },
    tool: 'python3',
    code: 'print("ok")',
    trustedRoot,
    runStoreRoot: path.join(trustedRoot, 'runs'),
  });

  const spec = present(sandbox.capturedSpec, 'captured VM python spec');
  assert.equal(spec.tool, 'python3');
  assert.deepEqual(spec.env, {});
});

test('runCode does not let embedded Python bypass the sandbox allowlist', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const embeddedPython = path.join(trustedRoot, 'runtime', process.platform === 'win32' ? 'python.exe' : 'python');
  const sandbox: SandboxLike = {
    backend: 'local-subprocess',
    exec: async () => {
      throw new Error('sandbox.exec should not be called');
    },
  };

  await assert.rejects(
    () => runCode({
      sandbox,
      sandboxLimits: { allowTools: ['node'] },
      runtimeEnv: { KCW_EMBEDDED_PYTHON: embeddedPython },
      tool: 'python3',
      code: 'print("ok")',
      trustedRoot,
      runStoreRoot: path.join(trustedRoot, 'runs'),
    }),
    /not in the allowlist/,
  );
});

test('runCode prefers the host Node runtime on the local backend', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const nodeExecPath = path.join(trustedRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const sandbox = makeCapturingSandbox('local-subprocess');

  await runCode({
    sandbox,
    sandboxLimits: { allowTools: sandboxAllowTools() },
    runtimeEnv: {},
    nodeExecPath,
    tool: 'node',
    code: 'process.stdout.write("ok")',
    trustedRoot,
    runStoreRoot: path.join(trustedRoot, 'runs'),
  });

  const spec = present(sandbox.capturedSpec, 'captured node spec');
  assert.equal(spec.tool, path.basename(nodeExecPath));
  assert.equal(spec.env.PATH, path.dirname(nodeExecPath));
});

test('runCode keeps VM Node tools inside the VM image', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const nodeExecPath = path.join(trustedRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const sandbox = makeCapturingSandbox('vm:docker');

  await runCode({
    sandbox,
    sandboxLimits: { allowTools: sandboxAllowTools() },
    runtimeEnv: {},
    nodeExecPath,
    tool: 'node',
    code: 'process.stdout.write("ok")',
    trustedRoot,
    runStoreRoot: path.join(trustedRoot, 'runs'),
  });

  const spec = present(sandbox.capturedSpec, 'captured VM node spec');
  assert.equal(spec.tool, 'node');
  assert.deepEqual(spec.env, {});
});

test('runCode does not let local Node runtime bypass the sandbox allowlist', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const nodeExecPath = path.join(trustedRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'node');
  const sandbox: SandboxLike = {
    backend: 'local-subprocess',
    exec: async () => {
      throw new Error('sandbox.exec should not be called');
    },
  };

  await assert.rejects(
    () => runCode({
      sandbox,
      sandboxLimits: { allowTools: ['python3'] },
      runtimeEnv: {},
      nodeExecPath,
      tool: 'node',
      code: 'process.stdout.write("ok")',
      trustedRoot,
      runStoreRoot: path.join(trustedRoot, 'runs'),
    }),
    /not in the allowlist/,
  );
});

test('runCode ignores relative Node runtime configuration', async () => {
  const trustedRoot = tempRoot('kcw-sbx-');
  const sandbox = makeCapturingSandbox('local-subprocess');

  await runCode({
    sandbox,
    sandboxLimits: { allowTools: sandboxAllowTools() },
    runtimeEnv: { KCW_NODE_HOME: '..\\not-absolute' },
    nodeExecPath: path.join(trustedRoot, 'agent-cowork-host.exe'),
    tool: 'node',
    code: 'process.stdout.write("ok")',
    trustedRoot,
    runStoreRoot: path.join(trustedRoot, 'runs'),
  });

  const spec = present(sandbox.capturedSpec, 'captured relative node spec');
  assert.equal(spec.tool, 'node');
  assert.deepEqual(spec.env, {});
});
