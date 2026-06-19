// Host 测试覆盖率入口(scripts · 门禁/报告)
// ---------------------------------------------------------------------------
// 职责:用 Node 内置 test coverage 跑 apps/host 测试,捕获文本报告,并把本次证据写入
//       reports/coverage。支持 --fail-under=N 作为行覆盖率门禁。
// 依赖:Node test runner 的 --experimental-test-coverage,不依赖 Python/pytest 工具链。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type CoverageSummary = {
  linePct: number;
  branchPct: number;
  functionPct: number;
};

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostRoot = path.join(repoRoot, 'apps', 'host');
const coverageRoot = path.join(repoRoot, 'reports', 'coverage');
const registerLoaderUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'run-host-node.mjs'));
registerLoaderUrl.searchParams.set('register-only', '1');

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function parseFailUnder(args: string[]): number | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] || '';
    const value = arg.startsWith('--fail-under=') ? arg.slice('--fail-under='.length) : arg === '--fail-under' ? args[index + 1] : undefined;
    if (value == null) continue;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
      throw new Error(`--fail-under must be a percentage between 0 and 100: ${value}`);
    }
    return parsed;
  }
  return null;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, '');
}

function parseCoverageSummary(output: string): CoverageSummary | null {
  const lines = stripAnsi(output).replace(/\r/g, '').split('\n');
  const allFilesLine = lines.map((line) => line.replace(/^ℹ\s*/, '').trim()).find((line) => /^all files\s*\|/.test(line));
  if (!allFilesLine) return null;
  const cells = allFilesLine.split('|').map((cell) => cell.trim());
  const linePct = Number(cells[1]);
  const branchPct = Number(cells[2]);
  const functionPct = Number(cells[3]);
  if (![linePct, branchPct, functionPct].every(Number.isFinite)) return null;
  return { linePct, branchPct, functionPct };
}

function textOf(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  if (value) return value.toString('utf8');
  return '';
}

const failUnder = parseFailUnder(process.argv.slice(2));
const runId = timestamp();
const v8CoverageDir = path.join(coverageRoot, `host-v8-${runId}`);
const textReportPath = path.join(coverageRoot, 'host-coverage-latest.txt');
const summaryPath = path.join(coverageRoot, 'host-coverage-summary.json');

fs.mkdirSync(v8CoverageDir, { recursive: true });

const nodeArgs = [
  '--enable-source-maps',
  '--import',
  registerLoaderUrl.href,
  '--test',
  '--experimental-test-coverage',
  '--test-isolation=process',
  '--test-timeout=60000',
  '--import',
  '../../scripts/test-setup.ts',
  '--test-coverage-include=src/**/*.ts',
  'test/*.test.js',
  'test/*.test.ts',
];
const result = spawnSync(process.execPath, nodeArgs, {
  cwd: hostRoot,
  env: {
    ...process.env,
    NODE_V8_COVERAGE: v8CoverageDir,
    NO_COLOR: '1',
  },
  encoding: 'utf8',
});

const stdout = textOf(result.stdout);
const stderr = textOf(result.stderr);
const spawnErrorOutput = result.error ? `[coverage] spawn error: ${result.error.message}\n` : '';
const combinedOutput = `${stdout}${stderr}${spawnErrorOutput}`;
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
if (spawnErrorOutput) process.stderr.write(spawnErrorOutput);

fs.writeFileSync(textReportPath, combinedOutput, 'utf8');

const summary = parseCoverageSummary(combinedOutput);
const summaryDocument = {
  generatedAt: new Date().toISOString(),
  command: `node ${nodeArgs.join(' ')}`,
  status: result.status ?? (result.error ? 1 : 0),
  signal: result.signal || null,
  spawnError: result.error ? { name: result.error.name, message: result.error.message } : null,
  failUnderLinePct: failUnder,
  meetsFailUnder: summary && failUnder != null ? summary.linePct >= failUnder : null,
  summary,
  artifacts: {
    textReport: path.relative(repoRoot, textReportPath).split(path.sep).join('/'),
    summary: path.relative(repoRoot, summaryPath).split(path.sep).join('/'),
    v8CoverageDir: path.relative(repoRoot, v8CoverageDir).split(path.sep).join('/'),
  },
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summaryDocument, null, 2)}\n`, 'utf8');

console.log(`[coverage] wrote ${path.relative(repoRoot, textReportPath)} and ${path.relative(repoRoot, summaryPath)}`);

if (result.status) {
  process.exit(result.status);
}
if (!summary) {
  console.error('[coverage] failed to parse the Node coverage summary from test output.');
  process.exit(1);
}
if (failUnder != null && summary.linePct < failUnder) {
  console.error(`[coverage] line coverage ${summary.linePct}% is below required ${failUnder}%.`);
  process.exit(1);
}
