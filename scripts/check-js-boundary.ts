// JS/TS 边界门禁:仓库不得残留手写 JS 源(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:列出仓库内全部 .js/.jsx/.mjs/.cjs 文件(优先用 git ls-files 含已跟踪与未
//   跟踪文件,失败时回退磁盘遍历),只允许两类 JS 存在:由 TS 源生成的 bootstrap
//   引导器(host-ts-loader.mjs / run-host-node.mjs)与由 resources-src/*.ts 生成的
//   资源脚本。任何其他 JS-like 源都视为越界(防止手写 JS 悄悄混入 TS-only 代码库)。
// 用法:npm run check:js-boundary(经 run-host-node.mjs 运行),也是 npm run check
//   聚合门禁的一环。
// 依赖:git(取文件清单);发现意外 JS 源即 exit 1 阻断。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE_DIR = path.join(ROOT, 'apps', 'windows-client', 'resources');
const RESOURCE_SOURCE_DIR = path.join(ROOT, 'apps', 'windows-client', 'resources-src');
const BOOTSTRAP_SOURCE_BY_SCRIPT = new Map([
  ['scripts/host-ts-loader.mjs', 'scripts/bootstrap-src/host-ts-loader.ts'],
  ['scripts/run-host-node.mjs', 'scripts/bootstrap-src/run-host-node.ts'],
]);
const SKIP_DIR_NAMES = new Set([
  '.git',
  '.AgentCowork',
  '.KimiCowork',
  'node_modules',
  'build',
  'dist',
  'coverage',
  'reports',
  'releases',
]);
const SKIP_PATH_PREFIXES = [
  'apps/windows-client/resources/python-embedded',
  'apps/windows-client/ui-dist',
  'apps/windows-client/ui/node_modules',
  'apps/windows-client/src-tauri/target',
  // viz 产物的浏览器端运行时:必须以纯 <script src> 全局脚本形式加载进桌面应用 CSP
  // (script-src 'self')限定的 sandbox="allow-scripts" iframe,不经过 Vite/TS 应用打包
  // 管线(public/ 是静态直出目录)。含第三方 vendor 库(chart.umd.min.js/mermaid.min.js)
  // 与配套的运行时/引导小脚本,详见 apps/host/src/artifacts/viz.ts 顶部 CSP 说明。
  'apps/windows-client/ui/public/vendor',
];

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function rel(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
}

function isSkipped(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/');
  const parts = normalized.split('/');
  if (parts.some((part) => SKIP_DIR_NAMES.has(part))) return true;
  return SKIP_PATH_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix}/`));
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = rel(full);
    if (isSkipped(relative)) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && ['.js', '.jsx', '.mjs', '.cjs'].includes(path.extname(entry.name))) {
      out.push(relative);
    }
  }
  return out;
}

function stdoutText(stdout: string | Buffer | undefined): string {
  return Buffer.isBuffer(stdout) ? stdout.toString('utf8') : String(stdout || '');
}

function gitFiles(args: string[]): string[] | null {
  const git = spawnSync('git', ['-c', `safe.directory=${ROOT}`, ...args, '-z', '--', '*.js', '*.jsx', '*.mjs', '*.cjs'], {
    cwd: ROOT,
    encoding: 'buffer',
    windowsHide: true,
  });
  if (git.status === 0 && git.stdout && stdoutText(git.stdout).length > 0) {
    return stdoutText(git.stdout).split('\0').filter((file) => file && !isSkipped(file));
  }
  return git.status === 0 ? [] : null;
}

function repositoryJsFiles(): string[] {
  // Catch local, untracked JS sources before they quietly become part of a later commit.
  const tracked = gitFiles(['ls-files']);
  const untracked = gitFiles(['ls-files', '--others', '--exclude-standard']);
  if (tracked && untracked) {
    return [...new Set([...tracked, ...untracked])].sort();
  }
  return walk(ROOT).sort();
}

function isGeneratedResourceScript(relativePath: string): boolean {
  const resourcePrefix = `${rel(RESOURCE_DIR)}/`;
  if (!relativePath.startsWith(resourcePrefix) || !relativePath.endsWith('.js')) return false;
  const sourceName = `${path.basename(relativePath, '.js')}.ts`;
  return fs.existsSync(path.join(RESOURCE_SOURCE_DIR, sourceName));
}

function isGeneratedBootstrapScript(relativePath: string): boolean {
  const source = BOOTSTRAP_SOURCE_BY_SCRIPT.get(relativePath);
  return Boolean(source && fs.existsSync(path.join(ROOT, source)));
}

const files = repositoryJsFiles();
const unexpected = files.filter((file) => {
  return !isGeneratedBootstrapScript(file) && !isGeneratedResourceScript(file);
});

if (unexpected.length > 0) {
  console.error('JS/TS boundary check failed: unexpected JavaScript-like source files remain.');
  for (const file of unexpected) {
    console.error(`- ${file}`);
  }
  process.exit(1);
}

const bootstraps = files.filter(isGeneratedBootstrapScript).length;
const generatedResources = files.filter(isGeneratedResourceScript).length;
console.log(`JS/TS boundary check passed (${bootstraps} generated bootstraps, ${generatedResources} generated resource scripts).`);
