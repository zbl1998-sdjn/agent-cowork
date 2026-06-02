// 统一以 TS 加载器运行任意 host Node 入口的 CLI 包装器(scripts · 工具库)
// ---------------------------------------------------------------------------
// 职责:解析命令行(可选 --cwd <仓库内相对目录>,经路径 jail 限制不得越出仓库;
//       -- 之后为传给 Node 的参数),再 spawn 子 Node 进程,用 --import 预载
//       run-host-node.mjs 安装 .js→.ts 迁移加载器后执行目标入口,子进程退出码透传。
// 用法:node scripts/run-host-node.mjs [--cwd <相对目录>] -- <node 参数...>;
//       被各 package.json 脚本复用,免得每个脚本各自实现 .js→.ts 解析规则。
// 依赖:scripts/run-host-node.mjs(register-only 预载入口)。
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const registerLoaderUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'run-host-node.mjs'));
// Reuse the JS entrypoint as a preload-only module for child processes, keeping
// the unavoidable bootstrap surface to one runner plus the loader itself.
registerLoaderUrl.searchParams.set('register-only', '1');

function resolveCwd(input?: string): string {
  const cwd = path.resolve(repoRoot, input || '.');
  const relative = path.relative(repoRoot, cwd);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`[run-host-node] cwd must stay inside the repo: ${input}`);
  }
  return cwd;
}

const args = process.argv.slice(2);
let cwd = repoRoot;
if (args[0] === '--cwd') {
  cwd = resolveCwd(args[1]);
  args.splice(0, 2);
}
if (args[0] === '--') args.shift();
if (!args.length) {
  console.error('Usage: node scripts/run-host-node.mjs [--cwd <repo-relative-dir>] -- <node-args...>');
  process.exit(1);
}

// Centralize the migration-time loader so package scripts do not each need
// their own copy of the .js -> .ts resolution rule.
const result = spawnSync(process.execPath, ['--import', registerLoaderUrl.href, ...args], {
  cwd,
  env: process.env,
  shell: false,
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
