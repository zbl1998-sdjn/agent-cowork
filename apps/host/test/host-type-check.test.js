import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const checkHostTypesScript = path.join(repoRoot, 'scripts', 'check-host-types.mjs');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

test('host type check detects missing and stale host source coverage', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-host-types-'));
  const configPath = path.join(root, 'tsconfig.host-checkjs.json');

  writeFile(path.join(root, 'apps', 'host', 'src', 'covered.js'), 'export const covered = true;\n');
  writeFile(path.join(root, 'apps', 'host', 'src', 'nested', 'missing.ts'), 'export const missing = true;\n');
  writeFile(
    configPath,
    JSON.stringify({
      compilerOptions: {},
      files: [
        'types/host-node-shim.d.ts',
        'apps/host/src/covered.js',
        'apps/host/src/stale.js',
      ],
    }),
  );

  const { findHostTypeCoverageIssues } = await import(pathToFileURL(checkHostTypesScript).href);
  const issues = findHostTypeCoverageIssues(root, configPath);

  assert.deepEqual(issues.missing, ['apps/host/src/nested/missing.ts']);
  assert.deepEqual(issues.stale, ['apps/host/src/stale.js']);
});
