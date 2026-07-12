// Host 测试覆盖率入口(scripts · 门禁/报告)
// ---------------------------------------------------------------------------
// 职责:用 Node 内置 test coverage 跑 apps/host 测试,捕获文本报告,并把本次证据写入
//       reports/coverage。支持 --fail-under=N 全局行门禁,并对静态策略中的关键文件
//       分别执行 line / branch / function 下限。
// 依赖:Node test runner 的 --experimental-test-coverage,不依赖 Python/pytest 工具链。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  coverageProcessExitCode,
  evaluateCoverageThresholds,
  formatCoverageEvidenceCommand,
  HOST_COVERAGE_ARTIFACT_PATHS,
  parseCoverageReport,
  parseHostCoverageThresholdPolicy,
  sanitizeCoverageEnvironment,
  type CoverageMetrics,
  type CoverageReport,
  type CoverageThresholdPolicy,
} from './coverage-policy.js';
import {
  HOST_COVERAGE_TIMEOUT_MS,
  runCoverageProcess,
} from './coverage-process.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hostRoot = path.join(repoRoot, 'apps', 'host');
const thresholdPolicyPath = path.join(repoRoot, 'scripts', 'host-coverage-thresholds.json');
const registerLoaderUrl = pathToFileURL(path.join(repoRoot, 'scripts', 'run-host-node.mjs'));
registerLoaderUrl.searchParams.set('register-only', '1');

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

function textOf(value: string | Buffer | undefined): string {
  if (typeof value === 'string') return value;
  if (value) return value.toString('utf8');
  return '';
}

const failUnder = parseFailUnder(process.argv.slice(2));
let thresholdPolicy: CoverageThresholdPolicy;
try {
  thresholdPolicy = parseHostCoverageThresholdPolicy(
    JSON.parse(fs.readFileSync(thresholdPolicyPath, 'utf8')) as unknown,
  );
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[coverage] failed to load critical-file policy: ${message}`);
  process.exit(1);
}

const textReportPath = path.resolve(repoRoot, HOST_COVERAGE_ARTIFACT_PATHS.textReport);
const summaryPath = path.resolve(repoRoot, HOST_COVERAGE_ARTIFACT_PATHS.summary);

fs.mkdirSync(path.dirname(summaryPath), { recursive: true });

const nodeArgs = [
  '--enable-source-maps',
  '--import',
  registerLoaderUrl.href,
  '--test',
  '--experimental-test-coverage',
  // Node 20+ already runs each matching test file in a separate child process
  // by default. Avoid the version-specific isolation flag: Node 22.23.1 still
  // exposes only its experimental name, while the stable name starts in 23.6.
  '--test-concurrency=8',
  // Coverage instrumentation makes process-heavy architecture fixtures slower
  // on shared CI runners. Keep a bounded per-file limit with measured headroom.
  '--test-timeout=120000',
  '--import',
  '../../scripts/test-setup.ts',
  '--test-coverage-include=src/**/*.ts',
  'test/*.test.js',
  'test/*.test.ts',
];
const result = await runCoverageProcess({
  command: process.execPath,
  args: nodeArgs,
  cwd: hostRoot,
  env: sanitizeCoverageEnvironment(process.env),
  timeoutMs: HOST_COVERAGE_TIMEOUT_MS,
});

const stdout = textOf(result.stdout);
const stderr = textOf(result.stderr);
const spawnErrorOutput = result.error ? `[coverage] spawn error: ${result.error.message}\n` : '';
const combinedOutput = `${stdout}${stderr}${spawnErrorOutput}`;
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
if (spawnErrorOutput) process.stderr.write(spawnErrorOutput);

fs.writeFileSync(textReportPath, combinedOutput, 'utf8');

let report: CoverageReport = { summary: null, files: new Map<string, CoverageMetrics>() };
let parseError: string | null = null;
try {
  report = parseCoverageReport(combinedOutput);
} catch (error) {
  parseError = error instanceof Error ? error.message : String(error);
}
const summary = report.summary;
const criticalCoverage = evaluateCoverageThresholds(report, thresholdPolicy);
const processExitCode = coverageProcessExitCode(result.status);
const summaryDocument = {
  generatedAt: new Date().toISOString(),
  command: formatCoverageEvidenceCommand(nodeArgs, registerLoaderUrl.href),
  status: processExitCode,
  signal: result.signal || null,
  timedOut: result.timedOut,
  timeoutMs: HOST_COVERAGE_TIMEOUT_MS,
  cleanupError: result.cleanupError || null,
  spawnError: result.error ? { name: result.error.name, message: result.error.message } : null,
  failUnderLinePct: failUnder,
  meetsFailUnder: summary && failUnder != null ? summary.linePct >= failUnder : null,
  summary,
  criticalCoverage: {
    policy: path.relative(repoRoot, thresholdPolicyPath).split(path.sep).join('/'),
    parseError,
    passed: parseError == null && criticalCoverage.failures.length === 0,
    failures: criticalCoverage.failures,
    observed: criticalCoverage.observed,
  },
  artifacts: {
    textReport: path.relative(repoRoot, textReportPath).split(path.sep).join('/'),
    summary: path.relative(repoRoot, summaryPath).split(path.sep).join('/'),
  },
};
fs.writeFileSync(summaryPath, `${JSON.stringify(summaryDocument, null, 2)}\n`, 'utf8');

console.log(`[coverage] wrote ${path.relative(repoRoot, textReportPath)} and ${path.relative(repoRoot, summaryPath)}`);

if (processExitCode !== 0) {
  process.exit(processExitCode);
}
if (parseError) {
  console.error(`[coverage] failed to parse the Node coverage report: ${parseError}`);
  process.exit(1);
}
if (!summary) {
  console.error('[coverage] failed to parse the Node coverage summary from test output.');
  process.exit(1);
}
if (failUnder != null && summary.linePct < failUnder) {
  console.error(`[coverage] line coverage ${summary.linePct}% is below required ${failUnder}%.`);
  process.exit(1);
}
if (criticalCoverage.failures.length > 0) {
  console.error('[coverage] critical-file coverage policy failed:');
  for (const failure of criticalCoverage.failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log(
  `[coverage] critical-file policy passed (`
  + `${Object.keys(criticalCoverage.observed).length} files, line/branch/function enforced).`,
);
