// Host 覆盖率逐文件棘轮的纯策略层(scripts · 门禁策略)
// ---------------------------------------------------------------------------
// 职责:解析 Node test runner 的层级 coverage 表,保留完整 src 路径,并对关键文件
//   分别执行 line / branch / function 下限。进程执行与证据写盘留在 run-host-coverage。
// 依赖:无外部依赖,供真实门禁与契约测试共用。

export type CoverageMetrics = {
  linePct: number;
  branchPct: number;
  functionPct: number;
};

export type CoverageReport = {
  summary: CoverageMetrics | null;
  files: Map<string, CoverageMetrics>;
};

export type CoverageThresholdPolicy = {
  schemaVersion: 1;
  files: Record<string, CoverageMetrics>;
};

export type CoverageThresholdResult = {
  failures: string[];
  observed: Record<string, CoverageMetrics>;
};

// These are irreversible lower bounds, not observed coverage. The JSON policy
// may raise them, but changing this map requires a reviewed source-code diff;
// silently lowering or deleting a JSON entry cannot weaken the gate.
const HOST_COVERAGE_PROTECTED_FLOORS = {
  'src/auth/sqlite-user-store.ts': { linePct: 90, branchPct: 70, functionPct: 85 },
  'src/auth/user-store.ts': { linePct: 90, branchPct: 80, functionPct: 85 },
  'src/connectors/oauth-github.ts': { linePct: 95, branchPct: 85, functionPct: 95 },
  'src/http/request-origin-policy.ts': { linePct: 85, branchPct: 70, functionPct: 95 },
  'src/kimi/agent/approval-gate.ts': { linePct: 95, branchPct: 85, functionPct: 95 },
  'src/kimi/agent/approval-support.ts': { linePct: 95, branchPct: 95, functionPct: 95 },
  'src/kimi/agent/model-call-capability.ts': { linePct: 75, branchPct: 95, functionPct: 95 },
  'src/kimi/agent/tool-call-executor.ts': { linePct: 95, branchPct: 85, functionPct: 95 },
  'src/orchestrator/provider-task-runner.ts': { linePct: 95, branchPct: 80, functionPct: 90 },
  'src/routes/orchestrator-security-mode.ts': { linePct: 95, branchPct: 95, functionPct: 95 },
  'src/runtime/approvals.ts': { linePct: 95, branchPct: 80, functionPct: 85 },
  'src/runtime/desktop-update-source.ts': { linePct: 95, branchPct: 60, functionPct: 95 },
  'src/sandbox/sandbox-spec.ts': { linePct: 85, branchPct: 70, functionPct: 95 },
  'src/sandbox/startup-probe-docker.ts': { linePct: 85, branchPct: 70, functionPct: 95 },
  'src/sandbox/startup-probe.ts': { linePct: 95, branchPct: 85, functionPct: 95 },
  'src/sandbox/wsl-docker-runner.ts': { linePct: 90, branchPct: 65, functionPct: 95 },
  'src/security/credential-store.ts': { linePct: 95, branchPct: 75, functionPct: 95 },
  'src/security/egress-gateway.ts': { linePct: 95, branchPct: 85, functionPct: 95 },
  'src/security/model-egress-approval.ts': { linePct: 95, branchPct: 95, functionPct: 95 },
  'src/security/model-endpoint-request.ts': { linePct: 95, branchPct: 85, functionPct: 80 },
  'src/security/model-gateway-policy.ts': { linePct: 95, branchPct: 95, functionPct: 95 },
  'src/security/path-policy.ts': { linePct: 90, branchPct: 75, functionPct: 85 },
  'src/security/public-host-policy.ts': { linePct: 95, branchPct: 95, functionPct: 95 },
  'src/security/security-mode.ts': { linePct: 95, branchPct: 80, functionPct: 90 },
  'src/storage/postgres-approvals.ts': { linePct: 90, branchPct: 85, functionPct: 80 },
  'src/storage/postgres-event-bus.ts': { linePct: 90, branchPct: 60, functionPct: 80 },
  'src/storage/postgres-migration-baseline.ts': { linePct: 95, branchPct: 95, functionPct: 95 },
  'src/storage/postgres-migration-plan.ts': { linePct: 90, branchPct: 75, functionPct: 95 },
  'src/tools/ssrf-guard.ts': { linePct: 95, branchPct: 75, functionPct: 95 },
  'src/tools/web-fetch.ts': { linePct: 90, branchPct: 65, functionPct: 75 },
} as const satisfies Record<string, CoverageMetrics>;

export const HOST_COVERAGE_ARTIFACT_PATHS = Object.freeze({
  textReport: 'reports/coverage/generated/host-coverage-latest.txt',
  summary: 'reports/coverage/generated/host-coverage-summary.json',
});

export function formatCoverageEvidenceCommand(
  args: readonly string[],
  registerLoaderUrl: string,
): string {
  const portableLoaderUrl = 'file:///<repo>/scripts/run-host-node.mjs?register-only=1';
  return `node ${args.map((arg) => (
    arg === registerLoaderUrl ? portableLoaderUrl : arg
  )).join(' ')}`;
}

/** The built-in test reporter already emits the coverage table we parse.
 * Never propagate NODE_V8_COVERAGE: it writes one raw JSON file per process and
 * previously accumulated tens of GiB without being consumed. */
export function sanitizeCoverageEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const child = { ...env };
  Reflect.deleteProperty(child, 'NODE_V8_COVERAGE');
  child.NO_COLOR = '1';
  return child;
}

export function coverageProcessExitCode(status: number | null | undefined): number {
  return typeof status === 'number' ? status : 1;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B\[[0-9;]*m/g, '');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMetric(raw: string): number | null {
  if (!raw.trim()) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}

function isNormalizedSourcePath(value: string): boolean {
  return value.startsWith('src/')
    && value.endsWith('.ts')
    && !value.includes('\\')
    && !value.split('/').includes('..');
}

function parseThresholdMetric(filePath: string, name: keyof CoverageMetrics, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 100) {
    throw new Error(`coverage threshold ${filePath} ${name} must be > 0 and <= 100`);
  }
  return value;
}

export function parseCoverageThresholdPolicy(value: unknown): CoverageThresholdPolicy {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.files)) {
    throw new Error('coverage threshold policy must be an object with schemaVersion 1 and files');
  }

  const files: Record<string, CoverageMetrics> = {};
  for (const [filePath, rawMetrics] of Object.entries(value.files)) {
    if (!isNormalizedSourcePath(filePath)) {
      throw new Error(`coverage threshold path must be a normalized src/*.ts path: ${filePath}`);
    }
    if (!isRecord(rawMetrics)) {
      throw new Error(`coverage threshold metrics must be an object: ${filePath}`);
    }
    files[filePath] = {
      linePct: parseThresholdMetric(filePath, 'linePct', rawMetrics.linePct),
      branchPct: parseThresholdMetric(filePath, 'branchPct', rawMetrics.branchPct),
      functionPct: parseThresholdMetric(filePath, 'functionPct', rawMetrics.functionPct),
    };
  }
  if (Object.keys(files).length === 0) {
    throw new Error('coverage threshold policy must name at least one critical file');
  }
  return { schemaVersion: 1, files };
}

export function parseHostCoverageThresholdPolicy(value: unknown): CoverageThresholdPolicy {
  const policy = parseCoverageThresholdPolicy(value);
  const metrics = ['linePct', 'branchPct', 'functionPct'] as const;
  for (const [filePath, floors] of Object.entries(HOST_COVERAGE_PROTECTED_FLOORS)) {
    const configured = policy.files[filePath];
    if (!configured) throw new Error(`missing protected coverage threshold: ${filePath}`);
    for (const metric of metrics) {
      if (configured[metric] < floors[metric]) {
        throw new Error(
          `coverage threshold ${filePath} ${metric} ${configured[metric]}% is below protected floor ${floors[metric]}%`,
        );
      }
    }
  }
  return policy;
}

export function parseCoverageReport(output: string): CoverageReport {
  const files = new Map<string, CoverageMetrics>();
  const directoryStack: string[] = [];
  let summary: CoverageMetrics | null = null;

  for (const rawLine of stripAnsi(output).replace(/\r/g, '').split('\n')) {
    // Node emits coverage rows as either TAP diagnostics (#) or info diagnostics (ℹ),
    // depending on the runtime release and reporter.
    const match = /^(?:ℹ|#)(\s+)([^|]+?)\s*\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/.exec(rawLine);
    if (!match) continue;

    const indentation = match[1]?.length ?? 0;
    const name = match[2]?.trim() ?? '';
    const linePct = parseMetric(match[3] ?? '');
    const branchPct = parseMetric(match[4] ?? '');
    const functionPct = parseMetric(match[5] ?? '');
    const level = Math.max(0, indentation - 2);

    if (linePct == null || branchPct == null || functionPct == null) {
      if (name && name !== 'all files') {
        directoryStack.length = level;
        directoryStack[level] = name;
      }
      continue;
    }

    const metrics = { linePct, branchPct, functionPct };
    if (name === 'all files') {
      summary = metrics;
      continue;
    }

    const filePath = ['src', ...directoryStack.slice(0, level), name].join('/');
    if (files.has(filePath)) {
      throw new Error(`duplicate coverage row for ${filePath}`);
    }
    files.set(filePath, metrics);
  }

  return { summary, files };
}

export function evaluateCoverageThresholds(
  report: CoverageReport,
  policy: CoverageThresholdPolicy,
): CoverageThresholdResult {
  const failures: string[] = [];
  const observed: Record<string, CoverageMetrics> = {};
  const metrics = [
    ['linePct', 'line'],
    ['branchPct', 'branch'],
    ['functionPct', 'function'],
  ] as const;

  for (const filePath of Object.keys(policy.files).sort()) {
    const threshold = policy.files[filePath];
    const actual = report.files.get(filePath);
    if (!threshold) continue;
    if (!actual) {
      failures.push(`missing coverage row for critical file ${filePath}`);
      continue;
    }
    observed[filePath] = actual;
    for (const [metricKey, label] of metrics) {
      if (actual[metricKey] < threshold[metricKey]) {
        failures.push(
          `${filePath} ${label} coverage ${actual[metricKey]}% is below required `
          + `${threshold[metricKey]}%`,
        );
      }
    }
  }

  return { failures, observed };
}
