// 架构分层与依赖方向门禁(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:扫描 host(apps/host/src)与 UI(apps/windows-client/ui/src)源码,解析
//   静态/动态 import、export-from、require 的相对依赖,校验三类边界:UI 不得直接
//   import host 源码(只能走 lib/api 的 HTTP/SSE 契约)、host 不得依赖前端或 Tauri
//   外壳代码、host 内部 import 必须指向更低分层(L0→L4,不得反向);UI 内部按
//   lib→hooks→components→App/main 分层并禁止反向依赖。同时检测 import 环。
//   Host 分层不接受逐边白名单；发现反向依赖即失败。
// 用法:npm run check:arch(经 node scripts/run-host-node.mjs scripts/check-arch.ts
//   运行);也作为 npm run check 聚合门禁的一环。仅作为主入口时执行扫描。
// 依赖:分层定义内置于本文件 HOST_LAYERS/UI_LAYERS;失败即 exit 1 阻断。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.KCW_ARCH_CHECK_ROOT || DEFAULT_ROOT);
const HOST_ROOT = path.join(ROOT, 'apps', 'host', 'src');
const UI_ROOT = path.join(ROOT, 'apps', 'windows-client', 'ui', 'src');
const WINDOWS_CLIENT_ROOT = path.join(ROOT, 'apps', 'windows-client');
const HOST_SOURCE_EXTENSIONS = new Set(['.js', '.ts']);

type HostLayer = {
  name: string;
  rank: number;
  prefixes?: string[];
  files?: string[];
};

type UiLayer = HostLayer;

const HOST_LAYERS = [
  { name: 'L0', rank: 0, prefixes: ['security/', 'http/', 'util/'] },
  {
    name: 'L1',
    rank: 1,
    prefixes: [
      'artifacts/',
      'auth/',
      'connectors/',
      'engine/',
      'mcp/',
      'memory/',
      'onboarding/',
      'recipes/',
      'sandbox/',
      'skills/',
      'storage/',
      'tools/',
      'workspace/',
    ],
  },
  { name: 'L2', rank: 2, prefixes: ['orchestrator/', 'runtime/'] },
  { name: 'L3', rank: 3, prefixes: ['routes/'] },
  { name: 'L4', rank: 4, files: ['server.ts', 'main.ts'] },
] satisfies HostLayer[];

// plan/00 defines lib as the UI contract/foundation, hooks as state/data
// orchestration, components as rendering, and App/main as composition roots.
// New production TypeScript must fit one of these zones; unknown directories
// fail closed instead of silently escaping dependency checks.
const UI_LAYERS = [
  { name: 'UI-L0', rank: 0, prefixes: ['lib/'] },
  { name: 'UI-L1', rank: 1, prefixes: ['hooks/'] },
  { name: 'UI-L2', rank: 2, prefixes: ['components/'] },
  { name: 'UI-L3', rank: 3, files: ['App.tsx'] },
  { name: 'UI-L4', rank: 4, files: ['main.tsx'] },
] satisfies UiLayer[];

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function relFromRoot(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
}

function walk(dir: string, predicate: (filePath: string) => boolean, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.endsWith('.tsbuildinfo')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, predicate, out);
    } else if (predicate(full)) {
      out.push(full);
    }
  }
  return out;
}

function isHostSource(filePath: string): boolean {
  return filePath.startsWith(HOST_ROOT + path.sep) && HOST_SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function isUiSource(filePath: string): boolean {
  if (!filePath.startsWith(UI_ROOT + path.sep)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(filePath)) return false;
  return /\.(ts|tsx)$/.test(filePath);
}

function readImports(filePath: string): string[] {
  const source = fs.readFileSync(filePath, 'utf8');
  // Use the installed TypeScript scanner instead of approximating JavaScript
  // syntax with regexes. This covers multiline import/export declarations,
  // literal dynamic imports (including a second options argument), CommonJS
  // require calls and no-substitution template literals while ignoring trivia
  // and import-like text inside strings, templates, regex literals or comments.
  return ts.preProcessFile(source, true, true).importedFiles.map((reference) => reference.fileName);
}

function candidateFiles(base: string): string[] {
  const ext = path.extname(base);
  if (ext === '.js') {
    const withoutExt = base.slice(0, -ext.length);
    return [base, `${withoutExt}.ts`];
  }
  if (ext) return [base];
  return [
    `${base}.js`,
    `${base}.mjs`,
    `${base}.ts`,
    `${base}.tsx`,
    path.join(base, 'index.js'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
}

function resolveImport(fromFile: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const absolute = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of candidateFiles(absolute)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function hostLayer(filePath: string): HostLayer | null {
  const rel = toPosix(path.relative(HOST_ROOT, filePath));
  for (const layer of HOST_LAYERS) {
    if (layer.files?.includes(rel)) return layer;
    if (layer.prefixes?.some((prefix) => rel.startsWith(prefix))) return layer;
  }
  return null;
}

function uiLayer(filePath: string): UiLayer | null {
  const rel = toPosix(path.relative(UI_ROOT, filePath));
  for (const layer of UI_LAYERS) {
    if (layer.files?.includes(rel)) return layer;
    if (layer.prefixes?.some((prefix) => rel.startsWith(prefix))) return layer;
  }
  return null;
}

function checkBoundary(fromFile: string, targetFile: string, violations: string[]): void {
  const fromRel = relFromRoot(fromFile);
  const targetRel = relFromRoot(targetFile);
  const fromIsHost = fromFile.startsWith(HOST_ROOT + path.sep);
  const targetIsHost = targetFile.startsWith(HOST_ROOT + path.sep);
  const fromIsUi = fromFile.startsWith(UI_ROOT + path.sep);
  const targetIsUi = targetFile.startsWith(UI_ROOT + path.sep);
  const targetIsShell = targetFile.startsWith(path.join(WINDOWS_CLIENT_ROOT, 'src-tauri') + path.sep);

  if (fromIsUi && targetIsHost) {
    violations.push(`${fromRel} imports host source ${targetRel}; UI must use lib/api HTTP/SSE contracts`);
  }
  if (fromIsHost && targetIsUi) {
    violations.push(`${fromRel} imports UI source ${targetRel}; host must not depend on frontend code`);
  }
  if (fromIsHost && targetIsShell) {
    violations.push(`${fromRel} imports Tauri shell source ${targetRel}; host must stay shell-agnostic`);
  }

  if (fromIsHost && targetIsHost) {
    const fromLayer = hostLayer(fromFile);
    const targetLayer = hostLayer(targetFile);
    if (!fromLayer || !targetLayer) return;
    if (targetLayer.rank > fromLayer.rank && fromFile !== targetFile) {
      violations.push(
        `${fromRel} (${fromLayer.name}) imports ${targetRel} (${targetLayer.name}); host imports must point inward to lower layers`,
      );
    }
  }

  if (fromIsUi && targetIsUi) {
    const fromLayer = uiLayer(fromFile);
    const targetLayer = uiLayer(targetFile);
    if (!fromLayer || !targetLayer) return;
    if (targetLayer.rank > fromLayer.rank && fromFile !== targetFile) {
      violations.push(
        fromRel + ' (' + fromLayer.name + ') imports ' + targetRel + ' (' + targetLayer.name
          + '); UI imports must point inward from roots/components/hooks to lib',
      );
    }
  }
}

function findCycles(graph: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  function dfs(node: string): void {
    state.set(node, 'visiting');
    stack.push(node);
    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue;
      if (state.get(next) === 'visiting') {
        const start = stack.indexOf(next);
        cycles.push([...stack.slice(start), next]);
      } else if (!state.has(next)) {
        dfs(next);
      }
    }
    stack.pop();
    state.set(node, 'done');
  }

  for (const node of graph.keys()) {
    if (!state.has(node)) dfs(node);
  }
  return cycles;
}

function runMain(): void {
  const files = [
    ...walk(HOST_ROOT, isHostSource),
    ...walk(UI_ROOT, isUiSource),
  ];
  const fileSet = new Set(files);
  const graph = new Map<string, string[]>(files.map((file) => [file, []]));
  const violations: string[] = [];

  for (const file of files.filter(isHostSource)) {
    if (!hostLayer(file)) {
      violations.push(relFromRoot(file) + ' is not assigned to a host architecture layer');
    }
  }

  for (const file of files.filter(isUiSource)) {
    if (!uiLayer(file)) {
      violations.push(relFromRoot(file) + ' is not assigned to a UI architecture layer');
    }
  }

  for (const file of files) {
    for (const specifier of readImports(file)) {
      const target = resolveImport(file, specifier);
      if (!target) continue;
      if (!fileSet.has(target)) continue;
      graph.get(file)?.push(target);
      checkBoundary(file, target, violations);
    }
  }

  for (const cycle of findCycles(graph)) {
    violations.push(`import cycle: ${cycle.map(relFromRoot).join(' -> ')}`);
  }

  if (violations.length) {
    console.error('Architecture check failed:');
    for (const violation of violations) {
      console.error(`- ${violation}`);
    }
    process.exit(1);
  }

  console.log(`Architecture check passed (${files.length} source files).`);
}

// Only run the architecture scan when invoked as the main entrypoint so this
// module can be imported by focused tests without scanning the repository.
const invokedAsMain = Boolean(process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (invokedAsMain) runMain();
