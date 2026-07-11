import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSandbox } from '../src/sandbox/index.js';
import { normalizeSandboxSpec } from '../src/sandbox/sandbox-spec.js';
import { isImmutableDockerImage } from '../src/sandbox/wsl-docker-runner.js';
import { recordValue, tempRoot } from './helpers/host-http.js';

const image = process.env.KCW_SANDBOX_REAL_DOCKER_IMAGE || '';
const requireRealDocker = process.env.KCW_REQUIRE_REAL_DOCKER_TEST === '1';
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('CI preloads a digest-pinned Docker image and requires the real sandbox tests', () => {
  const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const preload = workflow.indexOf('Preload the immutable sandbox integration image');
  const hostTests = workflow.indexOf('Run host tests with the enforced coverage gate');
  assert.ok(preload >= 0 && hostTests > preload, 'immutable image preload must precede host tests');
  assert.match(
    workflow,
    /alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1/,
  );
  assert.match(workflow, /docker pull "\$PINNED_SANDBOX_IMAGE"/);
  assert.match(workflow, /docker image inspect --format='\{\{\.Id\}\}' "\$PINNED_SANDBOX_IMAGE"/);
  assert.match(workflow, /KCW_SANDBOX_REAL_DOCKER_IMAGE=\$image_id/);
  assert.match(workflow, /KCW_REQUIRE_REAL_DOCKER_TEST=1/);
  assert.doesNotMatch(workflow, /KCW_SANDBOX_DOCKER_IMAGE:\s*""/);
});

test('operator docs require an immutable local Docker image ID instead of mutable tags', () => {
  const documents = [
    'README.md',
    path.join('docs', 'enterprise-local-strict-demo.md'),
    path.join('docs', '面试演示配置说明.md'),
    path.join('plan', 'README.md'),
    path.join('plan', '02-v1.0-任务拆解.md'),
  ].map((relativePath) => ({
    relativePath,
    text: fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'),
  }));

  for (const { relativePath, text } of documents) {
    assert.doesNotMatch(text, /agent-cowork-sandbox:local|postgres:16-alpine|KCW_SANDBOX_DOCKER_IMAGE=<local image>/, relativePath);
    assert.match(text, /sha256/i, `${relativePath} must explain immutable image identity`);
  }
  assert.match(documents[0]?.text || '', /docker image inspect --format='\{\{\.Id\}\}'/);
});

test('real Docker test contract requires a controlled immutable image when enforced', () => {
  if (!image) {
    assert.equal(
      requireRealDocker,
      false,
      'KCW_REQUIRE_REAL_DOCKER_TEST=1 requires KCW_SANDBOX_REAL_DOCKER_IMAGE',
    );
    return;
  }
  assert.equal(
    isImmutableDockerImage(image),
    true,
    'KCW_SANDBOX_REAL_DOCKER_IMAGE must be sha256:<64 lowercase hex> or <repository>@sha256:<64 lowercase hex>',
  );
});

test('docker VM sandbox blocks outbound network with --network=none', {
  skip: image ? false : 'set KCW_SANDBOX_REAL_DOCKER_IMAGE to a locally available immutable digest with sh+wget+id',
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

test('docker VM sandbox is non-root, keeps root/workspace read-only, and exposes only bounded /tmp writes', {
  skip: image ? false : 'set KCW_SANDBOX_REAL_DOCKER_IMAGE to a locally available immutable digest with sh+wget+id',
}, async () => {
  const sandbox = createSandbox({ backend: 'docker', image });
  const script = [
    'set -eu',
    'test "$(id -u)" != "0"',
    'touch /tmp/kcw-tmp-write',
    'if touch /work/kcw-workspace-write 2>/dev/null; then exit 126; fi',
    'if touch /etc/kcw-root-write 2>/dev/null; then exit 127; fi',
  ].join('; ');
  const spec = normalizeSandboxSpec({
    tool: 'sh',
    args: ['-c', script],
    timeoutMs: 8000,
  }, { allowTools: ['sh'] });

  const result = recordValue(await sandbox.exec(spec, { trustedRoot: tempRoot('kcw-sbx-docker-fs-') }), 'docker sandbox result');
  assert.equal(result.exitCode, 0, String(result.stderr));
});
