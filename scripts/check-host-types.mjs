import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(root, 'tsconfig.host-checkjs.json');
const candidates = [
  path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  path.join(root, 'apps', 'windows-client', 'ui', 'node_modules', 'typescript', 'bin', 'tsc'),
];

const tscPath = candidates.find((candidate) => fs.existsSync(candidate));
if (!tscPath) {
  console.error('[check-host-types] TypeScript compiler not found. Run npm install in apps/windows-client/ui first.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [tscPath, '-p', configPath, '--pretty', 'false'], {
  cwd: root,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
