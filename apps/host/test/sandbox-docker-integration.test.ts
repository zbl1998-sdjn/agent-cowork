import assert from 'node:assert/strict';
import test from 'node:test';
import { createSandbox } from '../src/sandbox/index.js';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { recordValue, tempRoot } from './helpers/host-http.js';

const image = process.env.KCW_SANDBOX_REAL_DOCKER_IMAGE || '';

test('docker VM sandbox blocks outbound network with --network=none', {
  skip: image ? false : 'set KCW_SANDBOX_REAL_DOCKER_IMAGE to a local image with sh+wget',
}, async () => {
  const sandbox = createSandbox({ backend: 'docker', image });
  const script = [
    'command -v wget >/dev/null || exit 125',
    'wget -T 2 -qO- http://1.1.1.1 >/tmp/kcw-net.out 2>/tmp/kcw-net.err',
    'code=$?',
    'cat /tmp/kcw-net.err >&2',
    'exit $code',
  ].join('; ');
  const spec = normalizeSandboxSpec({
    tool: 'sh',
    args: ['-c', script],
    timeoutMs: 8000,
  }, { allowTools: ['sh'] });

  const result = recordValue(await sandbox.exec(spec, { trustedRoot: tempRoot('kcw-sbx-docker-') }), 'docker sandbox result');
  const argv = result.argv;

  assert.equal(result.networkIsolated, true);
  assert.ok(Array.isArray(argv) && argv.includes('--network=none'), 'docker must be launched with no network');
  assert.ok(result.exitCode !== 125, 'integration image must provide wget');
  assert.ok(result.exitCode !== 0, 'network fetch must not succeed inside the isolated container');
  assert.match(String(result.stderr), /network|unreachable|can't connect|operation timed out/i);
});
