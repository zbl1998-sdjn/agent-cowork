// 校验生成的 bootstrap .mjs 与其 TS 源是否同步(scripts · 门禁(gate))
// ---------------------------------------------------------------------------
// 职责:把 scripts/bootstrap-src/ 下的 host-ts-loader.ts、run-host-node.ts 用
//   TypeScript transpileModule 重新编译,与已提交的 scripts/host-ts-loader.mjs、
//   scripts/run-host-node.mjs 逐字节比对(忽略换行差异)。这两个 .mjs 是 Node 跑
//   TS 的引导器,必须从 TS 源生成而非手改;不一致即判定为 stale。
// 用法:npm run check:bootstrap-js(经 run-host-node.mjs 运行);带 --write 时直接
//   把最新编译产物写回 .mjs(node scripts/run-host-node.mjs scripts/check-bootstrap-js.ts --write)。
//   也是 npm run check 聚合门禁的一环。
// 依赖:typescript;失败即 exit 1 阻断,并提示用 --write 重新生成。
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE_OUTPUT = process.argv.includes('--write');
const BOOTSTRAP_SCRIPTS = [
  {
    source: path.join(ROOT, 'scripts', 'bootstrap-src', 'host-ts-loader.ts'),
    output: path.join(ROOT, 'scripts', 'host-ts-loader.mjs'),
  },
  {
    source: path.join(ROOT, 'scripts', 'bootstrap-src', 'run-host-node.ts'),
    output: path.join(ROOT, 'scripts', 'run-host-node.mjs'),
  },
] as const;

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join('/');
}

function rel(filePath: string): string {
  return toPosix(path.relative(ROOT, filePath));
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

function compileBootstrap(sourcePath: string): string {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const output = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022,
      sourceMap: false,
      inlineSources: false,
      removeComments: false,
    },
    reportDiagnostics: true,
  });
  const errors = (output.diagnostics || []).filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    throw new Error(errors.map(formatDiagnostic).join('\n'));
  }
  return output.outputText;
}

try {
  const stale: string[] = [];
  for (const entry of BOOTSTRAP_SCRIPTS) {
    const expected = compileBootstrap(entry.source);
    if (WRITE_OUTPUT) {
      fs.writeFileSync(entry.output, expected, 'utf8');
      continue;
    }
    const actual = fs.existsSync(entry.output) ? fs.readFileSync(entry.output, 'utf8') : '';
    if (normalizeNewlines(actual) !== normalizeNewlines(expected)) {
      stale.push(`${rel(entry.output)} is not up to date with ${rel(entry.source)}`);
    }
  }

  if (stale.length > 0) {
    console.error('Bootstrap JS check failed: generated bootstraps are stale.');
    for (const item of stale) console.error(`- ${item}`);
    console.error('Run: node scripts/run-host-node.mjs scripts/check-bootstrap-js.ts --write');
    process.exit(1);
  }
} catch (error) {
  console.error('Bootstrap JS check failed:');
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const action = WRITE_OUTPUT ? 'updated' : 'passed';
console.log(`Bootstrap JS check ${action} (${BOOTSTRAP_SCRIPTS.length} generated scripts).`);
