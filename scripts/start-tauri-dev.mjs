// Dev launcher for `tauri dev` with the React UI.
//
// Starts BOTH long-lived dev processes and links their lifecycles:
//   - the Node host on :3017 (API the UI talks to)
//   - the Vite dev server on :5173 (the React UI; Tauri's devUrl)
// If either exits, the other is torn down so `tauri dev` never leaves orphans.

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uiDir = path.join(repoRoot, 'apps', 'windows-client', 'ui');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children = [];
let shuttingDown = false;

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try { child.kill(); } catch { /* already gone */ }
  }
  process.exit(code);
}

function launch(command, args, opts = {}) {
  const child = spawn(command, args, { stdio: 'inherit', ...opts });
  children.push(child);
  child.on('exit', (code) => shutdown(code ?? 0));
  child.on('error', (error) => {
    console.error(`failed to start ${command}: ${error.message}`);
    shutdown(1);
  });
  return child;
}

// Node host (3017)
launch(process.execPath, [path.join(repoRoot, 'scripts', 'start-tauri-host.mjs')], { env: process.env });
// Vite dev server (5173)
launch(npm, ['run', 'dev'], { cwd: uiDir, shell: process.platform === 'win32' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => shutdown(0));
}
