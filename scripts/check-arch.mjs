import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(process.env.KCW_ARCH_CHECK_ROOT || DEFAULT_ROOT);
const HOST_ROOT = path.join(ROOT, 'apps', 'host', 'src');
const UI_ROOT = path.join(ROOT, 'apps', 'windows-client', 'ui', 'src');
const WINDOWS_CLIENT_ROOT = path.join(ROOT, 'apps', 'windows-client');
const HOST_SOURCE_EXTENSIONS = new Set(['.js', '.ts']);

const HOST_LAYERS = [
  { name: 'L0', rank: 0, prefixes: ['security/', 'http/', 'util/'] },
  {
    name: 'L1',
    rank: 1,
    prefixes: [
      'artifacts/',
      'auth/',
      'connectors/',
      'kimi/',
      'mcp/',
      'memory/',
      'recipes/',
      'sandbox/',
      'skills/',
      'storage/',
      'tools/',
      'workspace/',
    ],
  },
  { name: 'L2', rank: 2, prefixes: ['runtime/'] },
  { name: 'L3', rank: 3, prefixes: ['routes/'] },
  { name: 'L4', rank: 4, files: ['server.js', 'main.js'] },
];

// Known debt from plan/00, kept explicit so the guard still catches new
// violations while P0 split tasks remove these one by one.
const HOST_LAYER_WAIVERS = new Map([
  ['memory/memory-store.js -> runtime/runs-index.js', 'P0-T6 memory-store split'],
  ['memory/memory-store.js -> runtime/audit-events.js', 'P0-T6 memory-store split'],
  ['kimi/agent-runner.js -> runtime/run-store.js', 'P0-T5 agent-runner split'],
  ['kimi/agent-runner.js -> runtime/runs-index.js', 'P0-T5 agent-runner split'],
  ['kimi/agent-runner.js -> runtime/hooks.js', 'P0-T5 agent-runner split'],
  ['kimi/agent-runner.js -> runtime/action-audit.js', 'P0-T5 agent-runner split'],
  ['kimi/agent-runner.js -> runtime/circuit-breaker.js', 'P0-T5 agent-runner split'],
  ['kimi/agent/model-resilience.js -> runtime/model-breakers.js', 'model breaker is shared runtime protection used by the agent model call'],
  ['kimi/chat-stream.js -> runtime/run-store.js', 'stream runner currently records runs directly'],
  ['kimi/chat-stream.js -> runtime/runs-index.js', 'stream runner currently indexes runs directly'],
  ['recipes/run-recipe.js -> runtime/run-store.js', 'P0 recipe runner currently records runs directly'],
  ['recipes/run-recipe.js -> runtime/runs-index.js', 'P0 recipe runner currently indexes runs directly'],
  ['sandbox/code-runner.js -> runtime/run-store.js', 'P0 sandbox code runner currently records runs directly'],
  ['sandbox/code-runner.js -> runtime/runs-index.js', 'P0 sandbox code runner currently indexes runs directly'],
  ['storage/postgres-event-bus.js -> runtime/run-events.js', 'postgres event bus adapts runtime event shape'],
  ['tools/builtin-tools.js -> runtime/subagent.js', 'builtin tool registry wires subagent adapter'],
]);

const IMPORT_RE =
  /\b(?:import|export)\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function toPosix(filePath) {
  return filePath.split(path.sep).join('/');
}

function relFromRoot(filePath) {
  return toPosix(path.relative(ROOT, filePath));
}

function walk(dir, predicate, out = []) {
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

function isHostSource(filePath) {
  return filePath.startsWith(HOST_ROOT + path.sep) && HOST_SOURCE_EXTENSIONS.has(path.extname(filePath));
}

function isUiSource(filePath) {
  if (!filePath.startsWith(UI_ROOT + path.sep)) return false;
  if (/\.(test|spec)\.(ts|tsx)$/.test(filePath)) return false;
  return /\.(ts|tsx)$/.test(filePath);
}

function readImports(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  const imports = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    imports.push(match[1] || match[2] || match[3]);
  }
  return imports;
}

function candidateFiles(base) {
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

function resolveImport(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const absolute = path.resolve(path.dirname(fromFile), specifier);
  for (const candidate of candidateFiles(absolute)) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

function hostLayer(filePath) {
  const rel = toPosix(path.relative(HOST_ROOT, filePath));
  for (const layer of HOST_LAYERS) {
    if (layer.files?.includes(rel)) return layer;
    if (layer.prefixes?.some((prefix) => rel.startsWith(prefix))) return layer;
  }
  return null;
}

function checkBoundary(fromFile, targetFile, violations) {
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
      const key = `${toPosix(path.relative(HOST_ROOT, fromFile))} -> ${toPosix(path.relative(HOST_ROOT, targetFile))}`;
      if (!HOST_LAYER_WAIVERS.has(key)) {
        violations.push(
          `${fromRel} (${fromLayer.name}) imports ${targetRel} (${targetLayer.name}); host imports must point inward to lower layers`,
        );
      }
    }
  }
}

function findCycles(graph) {
  const cycles = [];
  const state = new Map();
  const stack = [];

  function dfs(node) {
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

const files = [
  ...walk(HOST_ROOT, isHostSource),
  ...walk(UI_ROOT, isUiSource),
];
const fileSet = new Set(files);
const graph = new Map(files.map((file) => [file, []]));
const violations = [];

for (const file of files) {
  for (const specifier of readImports(file)) {
    const target = resolveImport(file, specifier);
    if (!target) continue;
    if (!fileSet.has(target)) continue;
    graph.get(file).push(target);
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
