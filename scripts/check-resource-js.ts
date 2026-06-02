// 资源脚本与其 TS 源一致性 + 经典脚本语法门禁(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:校验 apps/windows-client/resources/*.js 与 resources-src/*.ts 一一对应:
//   1) 用 tsconfig.windows-resources.json 把 TS 源编译到临时目录,逐字节比对已提交
//      的 .js,不一致即判定 stale;同时检查无孤立 .js(缺源)或漏生成的脚本;
//   2) 每个 .js 以 node:vm 的 Script(非 module 边界)解析,确保仍是 index.html 可
//      直接加载的经典脚本语法。
// 用法:npm run check:resource-js(经 run-host-node.mjs 运行),也是 npm run check
//   聚合门禁的一环。
// 依赖:typescript、node:vm;源/产物不一致或语法错误即 exit 1 阻断。
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RESOURCE_DIR = path.join(ROOT, 'apps', 'windows-client', 'resources');
const RESOURCE_SOURCE_DIR = path.join(ROOT, 'apps', 'windows-client', 'resources-src');
const RESOURCE_TSCONFIG = path.join(ROOT, 'tsconfig.windows-resources.json');

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function rel(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
}

function listResourceScripts(): string[] {
  return fs
    .readdirSync(RESOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.js'))
    .map((entry) => path.join(RESOURCE_DIR, entry.name))
    .sort((a, b) => rel(a).localeCompare(rel(b)));
}

function listResourceSources(): string[] {
  return fs
    .readdirSync(RESOURCE_SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts'))
    .map((entry) => path.join(RESOURCE_SOURCE_DIR, entry.name))
    .sort((a, b) => rel(a).localeCompare(rel(b)));
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file && typeof diagnostic.start === 'number') {
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${rel(diagnostic.file.fileName)}:${pos.line + 1}:${pos.character + 1} TS${diagnostic.code}: ${message}`;
  }
  return `TS${diagnostic.code}: ${message}`;
}

function emitResourcesTo(outDir: string): void {
  const configFile = ts.readConfigFile(RESOURCE_TSCONFIG, ts.sys.readFile);
  if (configFile.error) {
    throw new Error(formatDiagnostic(configFile.error));
  }
  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    ROOT,
    { outDir, noEmit: false },
    RESOURCE_TSCONFIG,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map(formatDiagnostic).join('\n'));
  }
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const result = program.emit();
  const diagnostics = ts.getPreEmitDiagnostics(program).concat(result.diagnostics);
  if (diagnostics.length > 0) {
    throw new Error(diagnostics.map(formatDiagnostic).join('\n'));
  }
}

function assertGeneratedScriptsAreCurrent(sources: string[], scripts: string[]): void {
  const expectedScriptNames = new Set(sources.map((source) => `${path.basename(source, '.ts')}.js`));
  const actualScriptNames = new Set(scripts.map((script) => path.basename(script)));
  for (const expected of expectedScriptNames) {
    if (!actualScriptNames.has(expected)) {
      throw new Error(`missing generated script ${rel(path.join(RESOURCE_DIR, expected))}`);
    }
  }
  for (const actual of actualScriptNames) {
    if (!expectedScriptNames.has(actual)) {
      throw new Error(`resource script has no TS source: ${rel(path.join(RESOURCE_DIR, actual))}`);
    }
  }

  const tempOut = fs.mkdtempSync(path.join(path.dirname(RESOURCE_DIR), '.resource-ts-check-'));
  try {
    emitResourcesTo(tempOut);
    for (const script of scripts) {
      const generated = path.join(tempOut, path.basename(script));
      if (!fs.existsSync(generated)) {
        throw new Error(`TypeScript did not emit ${rel(script)}`);
      }
      const expected = normalizeNewlines(fs.readFileSync(generated, 'utf8'));
      const actual = normalizeNewlines(fs.readFileSync(script, 'utf8'));
      if (actual !== expected) {
        throw new Error(`${rel(script)} is not up to date with ${rel(path.join(RESOURCE_SOURCE_DIR, `${path.basename(script, '.js')}.ts`))}`);
      }
    }
  } finally {
    fs.rmSync(tempOut, { recursive: true, force: true });
  }
}

function assertClassicScriptSyntax(filePath: string): void {
  const source = fs.readFileSync(filePath, 'utf8');
  try {
    // These files are loaded by index.html as classic scripts, so parse them
    // with the same non-module boundary before the TS migration removes them.
    new Script(source, { filename: filePath, displayErrors: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${rel(filePath)}: ${message}`);
  }
}

const scripts = listResourceScripts();
const sources = listResourceSources();

if (scripts.length === 0) {
  console.error(`Resource JS check failed: no scripts found in ${rel(RESOURCE_DIR)}.`);
  process.exit(1);
}
if (sources.length === 0) {
  console.error(`Resource JS check failed: no TypeScript sources found in ${rel(RESOURCE_SOURCE_DIR)}.`);
  process.exit(1);
}

try {
  assertGeneratedScriptsAreCurrent(sources, scripts);
  for (const script of scripts) {
    assertClassicScriptSyntax(script);
  }
} catch (error) {
  console.error('Resource JS syntax check failed:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

console.log(`Resource TS/JS check passed (${scripts.length} generated scripts).`);
