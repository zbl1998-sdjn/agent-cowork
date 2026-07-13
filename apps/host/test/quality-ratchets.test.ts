import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  evaluateFileSizePolicy,
  parseFileSizeBaseline,
  type FileSizeBaseline,
} from '../../../scripts/filesize-policy.js';
import {
  coverageProcessExitCode,
  evaluateCoverageThresholds,
  HOST_COVERAGE_ARTIFACT_PATHS,
  parseCoverageReport,
  parseHostCoverageThresholdPolicy,
  parseCoverageThresholdPolicy,
  sanitizeCoverageEnvironment,
  type CoverageThresholdPolicy,
} from '../../../scripts/coverage-policy.js';

const FILE_SIZE_BASELINE: FileSizeBaseline = {
  schemaVersion: 1,
  softLimit: 250,
  hardLimit: 400,
  files: {
    'apps/host/src/existing-large.ts': { maxLines: 300 },
  },
};

test('file-size policy rejects growth and new oversized source files', () => {
  const unchanged = evaluateFileSizePolicy({
    baseline: FILE_SIZE_BASELINE,
    files: new Map([['apps/host/src/existing-large.ts', 300]]),
  });
  assert.deepEqual(unchanged.failures, []);
  assert.equal(unchanged.warnings.length, 1);

  const grown = evaluateFileSizePolicy({
    baseline: FILE_SIZE_BASELINE,
    files: new Map([['apps/host/src/existing-large.ts', 301]]),
  });
  assert.match(grown.failures.join('\n'), /301 lines exceeds no-growth baseline \(300\)/);

  const shrunkWithoutBaselineUpdate = evaluateFileSizePolicy({
    baseline: FILE_SIZE_BASELINE,
    files: new Map([['apps/host/src/existing-large.ts', 299]]),
  });
  assert.match(
    shrunkWithoutBaselineUpdate.failures.join('\n'),
    /baseline must be tightened from 300 to 299/,
  );

  const newOversized = evaluateFileSizePolicy({
    baseline: FILE_SIZE_BASELINE,
    files: new Map([
      ['apps/host/src/existing-large.ts', 300],
      ['apps/host/src/new-large.ts', 251],
    ]),
  });
  assert.match(newOversized.failures.join('\n'), /new-large\.ts: 251 lines exceeds soft limit \(250\); no baseline entry/);
});

test('file-size policy rejects stale baselines and preserves the absolute hard limit', () => {
  const stale = evaluateFileSizePolicy({
    baseline: FILE_SIZE_BASELINE,
    files: new Map([['apps/host/src/existing-large.ts', 250]]),
  });
  assert.match(stale.failures.join('\n'), /stale baseline entry/);

  const hardLimit = evaluateFileSizePolicy({
    baseline: {
      ...FILE_SIZE_BASELINE,
      files: { 'apps/host/src/existing-large.ts': { maxLines: 450 } },
    },
    files: new Map([['apps/host/src/existing-large.ts', 401]]),
  });
  assert.match(hardLimit.failures.join('\n'), /exceeds hard limit \(400\)/);
});

test('file-size baseline parser cannot loosen the fixed limits', () => {
  assert.throws(
    () => parseFileSizeBaseline({ ...FILE_SIZE_BASELINE, softLimit: 300 }),
    /limits must remain 250\/400/,
  );
  assert.throws(
    () => parseFileSizeBaseline({
      ...FILE_SIZE_BASELINE,
      files: { 'apps/host/src/existing-large.ts': { maxLines: 401 } },
    }),
    /above 250 and at most 400/,
  );
});

const COVERAGE_TEXT = `
ℹ  auth                                 |        |          |         |
ℹ   user-store.ts                       |  96.10 |    85.19 |   87.50 |
ℹ  kimi                                 |        |          |         |
ℹ   agent                               |        |          |         |
ℹ    approval-gate.ts                   | 100.00 |    93.67 |  100.00 |
ℹ all files                             |  94.00 |    79.00 |   95.00 |
`;

const NODE_22_TAP_COVERAGE_TEXT = `
# file                                  | % line | % branch | % funcs |
# src                                   |        |          |         |
#  auth                                 |        |          |         |
#   user-store.ts                       |  96.10 |    85.19 |   87.50 |
#  kimi                                 |        |          |         |
#   agent                               |        |          |         |
#    approval-gate.ts                   | 100.00 |    93.67 |  100.00 |
# all files                             |  94.00 |    79.00 |   95.00 |
`;

const COVERAGE_POLICY: CoverageThresholdPolicy = {
  schemaVersion: 1,
  files: {
    'src/auth/user-store.ts': { linePct: 90, branchPct: 80, functionPct: 85 },
    'src/engine/agent/approval-gate.ts': { linePct: 95, branchPct: 90, functionPct: 95 },
  },
};

test('coverage parser preserves nested source paths and all three metrics', () => {
  const report = parseCoverageReport(COVERAGE_TEXT);

  assert.deepEqual(report.summary, { linePct: 94, branchPct: 79, functionPct: 95 });
  assert.deepEqual(report.files.get('src/auth/user-store.ts'), {
    linePct: 96.1,
    branchPct: 85.19,
    functionPct: 87.5,
  });
  assert.deepEqual(report.files.get('src/engine/agent/approval-gate.ts'), {
    linePct: 100,
    branchPct: 93.67,
    functionPct: 100,
  });
});

test('coverage parser accepts the Node 22 TAP diagnostic marker', () => {
  const report = parseCoverageReport(NODE_22_TAP_COVERAGE_TEXT);

  assert.deepEqual(report.summary, { linePct: 94, branchPct: 79, functionPct: 95 });
  assert.deepEqual(report.files.get('src/auth/user-store.ts'), {
    linePct: 96.1,
    branchPct: 85.19,
    functionPct: 87.5,
  });
  assert.deepEqual(report.files.get('src/engine/agent/approval-gate.ts'), {
    linePct: 100,
    branchPct: 93.67,
    functionPct: 100,
  });
});

test('coverage policy enforces line, branch, and function floors per critical file', () => {
  const report = parseCoverageReport(COVERAGE_TEXT);
  assert.deepEqual(evaluateCoverageThresholds(report, COVERAGE_POLICY).failures, []);

  const branchRegression = parseCoverageReport(COVERAGE_TEXT.replace('85.19', '79.99'));
  assert.match(
    evaluateCoverageThresholds(branchRegression, COVERAGE_POLICY).failures.join('\n'),
    /src\/auth\/user-store\.ts branch coverage 79\.99% is below required 80%/,
  );

  const lineRegression = parseCoverageReport(COVERAGE_TEXT.replace('96.10', '89.99'));
  assert.match(
    evaluateCoverageThresholds(lineRegression, COVERAGE_POLICY).failures.join('\n'),
    /src\/auth\/user-store\.ts line coverage 89\.99% is below required 90%/,
  );

  const functionRegression = parseCoverageReport(COVERAGE_TEXT.replace('87.50', '84.99'));
  assert.match(
    evaluateCoverageThresholds(functionRegression, COVERAGE_POLICY).failures.join('\n'),
    /src\/auth\/user-store\.ts function coverage 84\.99% is below required 85%/,
  );

  const missingCriticalFile = parseCoverageReport(COVERAGE_TEXT.replace('approval-gate.ts', 'renamed.ts'));
  assert.match(
    evaluateCoverageThresholds(missingCriticalFile, COVERAGE_POLICY).failures.join('\n'),
    /missing coverage row for critical file src\/kimi\/agent\/approval-gate\.ts/,
  );
});

test('coverage process status fails closed when a child exits without a numeric status', () => {
  assert.equal(coverageProcessExitCode(0), 0);
  assert.equal(coverageProcessExitCode(7), 7);
  assert.equal(coverageProcessExitCode(null), 1);
  assert.equal(coverageProcessExitCode(undefined), 1);
});

test('coverage artifacts are dynamic outputs and raw V8 collection is disabled', () => {
  assert.deepEqual(HOST_COVERAGE_ARTIFACT_PATHS, {
    textReport: 'reports/coverage/generated/host-coverage-latest.txt',
    summary: 'reports/coverage/generated/host-coverage-summary.json',
  });

  const inherited = {
    CI: '1',
    NODE_V8_COVERAGE: 'reports/coverage/host-v8-stale',
    NO_COLOR: '0',
  };
  const child = sanitizeCoverageEnvironment(inherited);
  assert.deepEqual(child, { CI: '1', NO_COLOR: '1' });
  assert.equal(inherited.NODE_V8_COVERAGE, 'reports/coverage/host-v8-stale');
});

test('coverage policy ratchets every model egress security boundary', () => {
  const policyPath = resolve(process.cwd(), '../../scripts/host-coverage-thresholds.json');
  const policy = parseCoverageThresholdPolicy(JSON.parse(readFileSync(policyPath, 'utf8')));
  const criticalFiles = [
    'src/engine/agent/approval-support.ts',
    'src/engine/agent/model-call-capability.ts',
    'src/routes/orchestrator-security-mode.ts',
    'src/security/model-egress-approval.ts',
    'src/security/model-endpoint-request.ts',
    'src/security/model-gateway-policy.ts',
    'src/security/public-host-policy.ts',
  ];

  for (const filePath of criticalFiles) {
    assert.ok(policy.files[filePath], `missing critical coverage ratchet: ${filePath}`);
  }
});

test('coverage policy ratchets sandbox, PostgreSQL approval, migration, and updater boundaries', () => {
  const policyPath = resolve(process.cwd(), '../../scripts/host-coverage-thresholds.json');
  const rawPolicy = JSON.parse(readFileSync(policyPath, 'utf8')) as {
    schemaVersion: number;
    files: Record<string, { linePct: number; branchPct: number; functionPct: number }>;
  };
  const policy = parseHostCoverageThresholdPolicy(rawPolicy);
  const criticalFiles = [
    'src/runtime/desktop-update-source.ts',
    'src/sandbox/sandbox-spec.ts',
    'src/sandbox/startup-probe-docker.ts',
    'src/sandbox/startup-probe.ts',
    'src/sandbox/wsl-docker-runner.ts',
    'src/storage/postgres-approvals.ts',
    'src/storage/postgres-event-bus.ts',
    'src/storage/postgres-migration-baseline.ts',
    'src/storage/postgres-migration-plan.ts',
  ];

  for (const filePath of criticalFiles) {
    assert.ok(policy.files[filePath], `missing critical coverage ratchet: ${filePath}`);
  }

  const lowered = structuredClone(rawPolicy);
  lowered.files['src/storage/postgres-event-bus.ts'] = {
    linePct: 1,
    branchPct: 1,
    functionPct: 1,
  };
  assert.throws(
    () => parseHostCoverageThresholdPolicy(lowered),
    /postgres-event-bus\.ts linePct 1% is below protected floor 90%/,
  );

  const removed = structuredClone(rawPolicy);
  Reflect.deleteProperty(removed.files, 'src/sandbox/startup-probe.ts');
  assert.throws(
    () => parseHostCoverageThresholdPolicy(removed),
    /missing protected coverage threshold: src\/sandbox\/startup-probe\.ts/,
  );
});
