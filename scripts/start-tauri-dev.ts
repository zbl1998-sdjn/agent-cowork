// Dev launcher for `tauri dev` with the React UI.
//
// Starts BOTH long-lived dev processes and links their lifecycles:
//   - the Node host on :3017 (API the UI talks to)
//   - the Vite dev server on :5173 (the React UI; Tauri's devUrl)
// If either exits, the other is torn down so `tauri dev` never leaves orphans.

import { spawn } from 'node:child_process';
import type { ChildProcessLike } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

type LaunchedProcess = ChildProcessLike & {
  on(event: 'exit', listener: (code: number | null) => void): unknown;
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const uiDir = path.join(repoRoot, 'apps', 'windows-client', 'ui');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const children: LaunchedProcess[] = [];
let shuttingDown = false;

function nodeExecPath(): string {
  const execPath = process.execPath;
  if (!execPath) {
    throw new Error('[start-tauri-dev] process.execPath is not available');
  }
  return execPath;
}

function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  process.exit(code);
}

function launch(command: string, args: string[], opts: Record<string, unknown> = {}): LaunchedProcess {
  const child = spawn(command, args, { stdio: 'inherit', ...opts }) as LaunchedProcess;
  children.push(child);
  child.on('exit', (code) => shutdown(code ?? 0));
  child.on('error', (error) => {
    console.error(`failed to start ${command}: ${error.message}`);
    shutdown(1);
  });
  return child;
}

// Node host (3017)
launch(nodeExecPath(), [
  path.join(repoRoot, 'scripts', 'run-host-node.mjs'),
  path.join(repoRoot, 'scripts', 'start-tauri-host.ts'),
], { env: process.env });
// Vite dev server (5173)
launch(npm, ['run', 'dev'], { cwd: uiDir, shell: process.platform === 'win32' });

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => shutdown(0));
}
