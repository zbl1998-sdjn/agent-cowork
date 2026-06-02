#!/usr/bin/env node
// 一键构建 React UI 子项目到 ui-dist(scripts · 构建)
// ---------------------------------------------------------------------------
// 职责:进入 apps/windows-client/ui,按需 npm install,再 npm run build,产物
//       落到 apps/windows-client/ui-dist(即 Tauri 外壳的 frontendDist),
//       并打印后续 cargo tauri dev/build 的指引。
// 用法:npm run build:ui;强制重装依赖用 npm run build:ui:fresh(透传 --install)。
// 依赖:Node + npm;UI 子项目的 package.json(install/build 脚本)。
//
// One-command activation for the React UI (iteration B).
//
//   npm run build:ui        # install if needed, then build -> ui-dist
//   npm run build:ui:fresh  # force a fresh npm install first
//
// Must run on a machine with Node + npm (this repo's host is zero-dependency;
// only the ui/ subproject has npm deps). After it succeeds, the Tauri shell's
// frontendDist (../ui-dist) is populated and you can run cargo tauri dev/build.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(root, 'apps', 'windows-client', 'ui');

// Run a full command line through the shell. We pass a single command string
// (no separate args array) so Node never emits DEP0190 for shell:true, and the
// same call works in cmd.exe / PowerShell / sh.
function run(cmdline: string, cwd: string): void {
  console.log(`\n> ${cmdline}   (cwd: ${path.relative(root, cwd) || '.'})`);
  const result = spawnSync(cmdline, { cwd, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    console.error(`\n[失败] ${cmdline} 退出码 ${result.status}`);
    process.exit(result.status || 1);
  }
}

if (!fs.existsSync(uiDir)) {
  console.error('[错误] 找不到 UI 目录:', uiDir);
  process.exit(1);
}

const hasModules = fs.existsSync(path.join(uiDir, 'node_modules'));
if (!hasModules || process.argv.includes('--install')) {
  run('npm install', uiDir);
} else {
  console.log('node_modules 已存在, 跳过 npm install (加 --install 可强制重装)。');
}
run('npm run build', uiDir);

console.log(`\n[完成] React UI 已构建 -> ${path.join('apps', 'windows-client', 'ui-dist')}`);
console.log('下一步 (需 Rust / cargo-tauri 的机器), 逐条执行:');
console.log('  cd apps/windows-client/src-tauri');
console.log('  cargo tauri dev      # 开发模式 (host + Vite 自动起)');
console.log('  cargo tauri build    # 打包桌面应用');
console.log('提示: Windows PowerShell 不支持 && 连接命令, 请分两行执行 (或用 ; 分隔)。');
