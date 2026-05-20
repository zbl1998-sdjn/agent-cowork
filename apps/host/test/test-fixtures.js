import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '..', '..', '..');
const testWorkspaceRoot = path.join(repoRoot, 'build', 'test-workspaces');

export function makeTestWorkspace(prefix) {
  fs.mkdirSync(testWorkspaceRoot, { recursive: true });
  return fs.mkdtempSync(path.join(testWorkspaceRoot, `${prefix}-`));
}
