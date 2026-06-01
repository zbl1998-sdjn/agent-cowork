import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const checkHostTypesScript = path.join(repoRoot, 'scripts', 'check-host-types.mjs');

type HostTypeCoverage = {
  missing: string[];
  stale: string[];
};
type CheckHostTypesModule = {
  findHostTypeCoverageIssues(root: string, configPath: string): HostTypeCoverage;
};

function writeFile(filePath: string, text: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
}

function toFileUrl(filePath: string): string {
  return `file:///${filePath.replace(/\\/g, '/')}`;
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

  const { findHostTypeCoverageIssues } = await import(toFileUrl(checkHostTypesScript)) as CheckHostTypesModule;
  const issues = findHostTypeCoverageIssues(root, configPath);

  assert.deepEqual(issues.missing, ['apps/host/src/nested/missing.ts']);
  assert.deepEqual(issues.stale, ['apps/host/src/stale.js']);
});
