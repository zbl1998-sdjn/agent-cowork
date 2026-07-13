// TS 文件必须被某个受检 tsconfig 覆盖的门禁(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:磁盘遍历仓库内所有 .ts/.tsx/.mts/.cts 源(跳过 node_modules、构建产物、
//   嵌入式 python 等目录),再解析 CHECKED_TSCONFIGS 中每个 tsconfig 实际纳入的
//   文件集合,二者求差:任何未被任一受检 tsconfig 覆盖的 TS 文件即视为「类型检查盲
//   区」并失败。确保不存在游离于所有工程之外、悄悄逃过类型检查的源文件。
// 用法:npm run check:ts-coverage(经 run-host-node.mjs 运行),也是 npm run check
//   聚合门禁的一环。
// 依赖:typescript(解析 tsconfig);存在未覆盖文件或 tsconfig 解析错误即 exit 1 阻断。
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHECKED_TSCONFIGS = [
  'tsconfig.host-test.json',
  'tsconfig.host-checkjs.json',
  'tsconfig.host-build.json',
  'tsconfig.eval.json',
  'tsconfig.scripts.json',
  'tsconfig.json',
  'tsconfig.windows-resources.json',
  'apps/windows-client/resources-src/tsconfig.json',
  'apps/windows-client/ui/tsconfig.json',
  'apps/windows-client/ui/tsconfig.node.json',
] as const;
const TS_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts']);
const SKIP_DIRS = new Set([
  '.git',
  '.claude',
  '.AgentCowork',
  '.KimiCowork',
  '.vscode',
  'node_modules',
  'build',
  'dist',
  'coverage',
  'reports',
  'releases',
  'apps/windows-client/resources/python-embedded',
  'apps/windows-client/ui-dist',
  'apps/windows-client/ui/node_modules',
  'apps/windows-client/src-tauri/target',
]);

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function rel(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
}

function normalizedAbsolute(filePath: string): string {
  return path.resolve(filePath);
}

function isSkipped(relativePath: string): boolean {
  const normalized = relativePath.split('\\').join('/');
  return normalized.split('/').some((_, index, parts) => {
    return SKIP_DIRS.has(parts.slice(0, index + 1).join('/'));
  });
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    const relative = rel(full);
    if (isSkipped(relative)) continue;
    if (entry.isDirectory()) {
      walk(full, out);
    } else if (entry.isFile() && TS_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(normalizedAbsolute(full));
    }
  }
  return out;
}

function formatDiagnostic(diagnostic: ts.Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
  if (diagnostic.file && typeof diagnostic.start === 'number') {
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${rel(diagnostic.file.fileName)}:${pos.line + 1}:${pos.character + 1} TS${diagnostic.code}: ${message}`;
  }
  return `TS${diagnostic.code}: ${message}`;
}

function collectConfiguredFiles(): { files: Set<string>; errors: string[] } {
  const files = new Set<string>();
  const errors: string[] = [];

  for (const configPath of CHECKED_TSCONFIGS) {
    const full = path.join(ROOT, configPath);
    const read = ts.readConfigFile(full, ts.sys.readFile);
    if (read.error) {
      errors.push(`${configPath}: ${formatDiagnostic(read.error)}`);
      continue;
    }

    const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(full), undefined, full);
    for (const error of parsed.errors) {
      errors.push(`${configPath}: ${formatDiagnostic(error)}`);
    }
    for (const fileName of parsed.fileNames) {
      files.add(normalizedAbsolute(fileName));
    }
  }

  return { files, errors };
}

const sourceFiles = walk(ROOT).sort((a, b) => rel(a).localeCompare(rel(b)));
const coverage = collectConfiguredFiles();
const uncovered = sourceFiles.filter((file) => !coverage.files.has(file));

if (coverage.errors.length > 0) {
  console.error('TS project coverage check failed: one or more tsconfig files could not be parsed.');
  for (const error of coverage.errors) console.error(`- ${error}`);
  process.exit(1);
}

if (uncovered.length > 0) {
  console.error('TS project coverage check failed: TS files are not covered by a checked tsconfig.');
  for (const file of uncovered) console.error(`- ${rel(file)}`);
  process.exit(1);
}

console.log(`TS project coverage check passed (${sourceFiles.length} source files, ${CHECKED_TSCONFIGS.length} tsconfigs).`);
