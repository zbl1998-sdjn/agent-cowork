// 对齐 VS Code Problems 的 TS 语言服务诊断门禁(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:遍历各 tsconfig 工程,逐文件用 TypeScript LanguageService 取语法、语义、
//   建议(suggestion)诊断——这正是 VS Code「Problems」面板会呈现的那批问题。目的
//   是把编辑器里能看到、但普通 tsc --noEmit 不一定报的诊断(尤其 suggestion 级)也
//   纳入 CI 门禁,避免「本地飘红、门禁全绿」。诊断去重排序后统一输出。
// 用法:npm run check:ts-language-service(经 run-host-node.mjs 运行),也是
//   npm run check 聚合门禁的一环。
// 依赖:typescript;存在任一诊断即 exit 1 阻断。
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
const SERVICE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function rel(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
}

function formatDiagnostic(configPath: string, diagnostic: ts.Diagnostic): string {
  const category = ts.DiagnosticCategory[diagnostic.category];
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');

  if (diagnostic.file && typeof diagnostic.start === 'number') {
    const pos = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
    return `${rel(diagnostic.file.fileName)}:${pos.line + 1}:${pos.character + 1} [${configPath}] ${category} TS${diagnostic.code}: ${message}`;
  }

  return `${configPath}: ${category} TS${diagnostic.code}: ${message}`;
}

function createLanguageService(configPath: string, parsed: ts.ParsedCommandLine): ts.LanguageService {
  const files = parsed.fileNames.filter((fileName) => SERVICE_EXTENSIONS.has(path.extname(fileName)));
  const versions = new Map(files.map((fileName) => [fileName, '0'] as const));

  const host: ts.LanguageServiceHost = {
    getScriptFileNames: () => files,
    getScriptVersion: (fileName) => versions.get(fileName) ?? '0',
    getScriptSnapshot: (fileName) => {
      if (!fs.existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(fs.readFileSync(fileName, 'utf8'));
    },
    getCurrentDirectory: () => path.dirname(path.resolve(ROOT, configPath)),
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
    useCaseSensitiveFileNames: () => ts.sys.useCaseSensitiveFileNames,
    getNewLine: () => ts.sys.newLine,
  };
  if (ts.sys.realpath) host.realpath = ts.sys.realpath;

  return ts.createLanguageService(host, ts.createDocumentRegistry());
}

function collectDiagnosticsForProject(configPath: string): string[] {
  const fullConfigPath = path.resolve(ROOT, configPath);
  const read = ts.readConfigFile(fullConfigPath, ts.sys.readFile);
  if (read.error) return [formatDiagnostic(configPath, read.error)];

  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(fullConfigPath), undefined, fullConfigPath);
  const diagnostics = parsed.errors.map((diagnostic) => formatDiagnostic(configPath, diagnostic));
  const files = parsed.fileNames.filter((fileName) => SERVICE_EXTENSIONS.has(path.extname(fileName)));
  const service = createLanguageService(configPath, parsed);

  try {
    for (const fileName of files) {
      // This mirrors the diagnostics VS Code's TypeScript language service can surface in Problems.
      diagnostics.push(
        ...service.getSyntacticDiagnostics(fileName).map((diagnostic) => formatDiagnostic(configPath, diagnostic)),
        ...service.getSemanticDiagnostics(fileName).map((diagnostic) => formatDiagnostic(configPath, diagnostic)),
        ...service.getSuggestionDiagnostics(fileName).map((diagnostic) => formatDiagnostic(configPath, diagnostic))
      );
    }
  } finally {
    service.dispose();
  }

  return diagnostics;
}

const diagnostics = CHECKED_TSCONFIGS.flatMap((configPath) => collectDiagnosticsForProject(configPath));
const uniqueDiagnostics = [...new Set(diagnostics)].sort();

if (uniqueDiagnostics.length > 0) {
  console.error('TypeScript language service check failed: diagnostics match VS Code Problems candidates.');
  for (const diagnostic of uniqueDiagnostics) console.error(`- ${diagnostic}`);
  process.exit(1);
}

console.log(`TypeScript language service check passed (${CHECKED_TSCONFIGS.length} tsconfigs).`);
