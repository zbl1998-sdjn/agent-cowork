import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const runHostNodeScript = path.join(repoRoot, 'scripts', 'run-host-node.mjs');
const checkArchScript = path.join(repoRoot, 'scripts', 'check-arch.ts');
const nodeExecutable = process.execPath ?? 'node';

function writeFile(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

test('architecture check includes host .ts sources and resolves .js specifiers to .ts files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-ts-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'tools', 'bad.ts'),
    "import '../routes/later.js';\nexport const value = 1;\n",
  );
  writeFile(path.join(root, 'apps', 'host', 'src', 'routes', 'later.ts'), 'export const later = 1;\n');

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.ok(result.status !== 0, output);
  assert.match(output, /Architecture check failed:/);
  assert.match(
    output,
    /apps\/host\/src\/tools\/bad\.ts \(L1\) imports apps\/host\/src\/routes\/later\.ts \(L3\)/,
  );
});

test('architecture waivers survive js-to-ts target migration', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-arch-waiver-ts-'));
  fs.mkdirSync(path.join(root, 'apps', 'windows-client', 'ui', 'src'), { recursive: true });

  writeFile(
    path.join(root, 'apps', 'host', 'src', 'kimi', 'agent', 'model-resilience.js'),
    "import { modelBreaker } from '../../runtime/model-breakers.js';\nexport const breaker = modelBreaker;\n",
  );
  writeFile(
    path.join(root, 'apps', 'host', 'src', 'runtime', 'model-breakers.ts'),
    'export function modelBreaker() { return null; }\n',
  );

  const result = spawnSync(nodeExecutable, [runHostNodeScript, checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });
  const output = String(result.stdout ?? '') + String(result.stderr ?? '');

  assert.equal(result.status, 0, output);
});
