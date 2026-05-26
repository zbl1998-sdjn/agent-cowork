import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const checkArchScript = path.join(repoRoot, 'scripts', 'check-arch.mjs');

function writeFile(filePath, text) {
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

  const result = spawnSync(process.execPath, [checkArchScript], {
    cwd: repoRoot,
    env: { ...process.env, KCW_ARCH_CHECK_ROOT: root },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /Architecture check failed:/);
  assert.match(
    result.stderr,
    /apps\/host\/src\/tools\/bad\.ts \(L1\) imports apps\/host\/src\/routes\/later\.ts \(L3\)/,
  );
});
