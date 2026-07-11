import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

test('host entrypoint remains compatible with the CJS SEA bundle', () => {
  const esbuild = path.join(
    repoRoot,
    'apps',
    'windows-client',
    'ui',
    'node_modules',
    'esbuild',
    'bin',
    'esbuild',
  );
  assert.ok(fs.existsSync(esbuild), 'locked esbuild binary must be installed');

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cowork-main-cjs-'));
  const output = path.join(outputDir, 'host-bundle.cjs');
  try {
    const result = spawnSync(process.execPath, [
      esbuild,
      path.join('apps', 'host', 'src', 'main.ts'),
      '--bundle',
      '--platform=node',
      '--format=cjs',
      `--outfile=${output}`,
      '--target=node22',
      '--define:import.meta.url="file:///C:/host-bundle.cjs"',
      '--log-level=silent',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      shell: false,
    });

    assert.equal(
      result.status,
      0,
      `CJS bundle failed:\n${result.stderr || result.stdout}`,
    );
    assert.ok(fs.statSync(output).size > 0, 'bundle output must not be empty');
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true });
  }
});
