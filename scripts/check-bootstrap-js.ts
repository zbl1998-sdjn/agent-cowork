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
