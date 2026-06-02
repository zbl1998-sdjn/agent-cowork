// 拉起 tauri dev 所需的双开发进程并联动生命周期(scripts · MVP生命周期)
// ---------------------------------------------------------------------------
// 职责:同时启动两个长驻开发进程并绑定其生命周期——
//       Node Host(:3017,UI 调用的 API,经 start-tauri-host.ts 启动)
//       与 Vite 开发服务器(:5173,React UI,即 Tauri 的 devUrl);
//       任一进程退出即连带关闭另一个,避免 tauri dev 残留孤儿进程。
// 用法:由 Tauri 在 tauri dev 前自动调用(tauri.conf.json 的 beforeDevCommand:
//       node ../../../scripts/run-host-node.mjs scripts/start-tauri-dev.ts),一般不单独运行。
// 依赖:scripts/start-tauri-host.ts(Host 进程)、apps/windows-client/ui 的 npm run dev(Vite)。

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
