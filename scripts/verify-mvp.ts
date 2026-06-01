import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const nodeBin = process.execPath;
const runHostNodeScript = path.join(repoRoot, 'scripts', 'run-host-node.mjs');
const args = new Set(process.argv.slice(2));
const includeWindowsClient =
  args.has('--windows-client') || process.env.VERIFY_WINDOWS_CLIENT === '1';
const reportPath = path.join(
  buildDir,
  includeWindowsClient ? 'mvp-verification-report-windows.json' : 'mvp-verification-report.json',
);

type CheckStatus = 'passed' | 'blocked' | 'failed';
type EnvOverrides = Record<string, string | undefined>;
type CheckConfig = {
  name: string;
  command: string;
  commandArgs: string[];
  cwd?: string;
  detectAsr?: boolean;
  extraEnv?: EnvOverrides;
};
type CheckResult = {
  name: string;
  status: CheckStatus;
  exitCode: number | null | undefined;
  durationMs: number;
  command: string;
  cwd: string;
  blockedByAsr: boolean;
  spawnError: string;
  outputTail: string[];
};
type VerificationSummary = {
  ok: boolean;
  passed: number;
  failed: number;
  blocked: number;
};

function runCheck({
  name,
  command,
  commandArgs,
  cwd = repoRoot,
  detectAsr = false,
  extraEnv = {},
}: CheckConfig): CheckResult {
  const startedAt = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv, CI: '1' },
    shell: false,
    windowsHide: true,
  });
  const durationMs = Date.now() - startedAt;
  const spawnError = result.error ? `${result.error.name}: ${result.error.message}` : '';
  const output = `${result.stdout || ''}${result.stderr || ''}${spawnError}`;
  const blockedByAsr =
    detectAsr &&
    result.status !== 0 &&
    output.includes('01443614-CD74-433A-B99E-2ECDC07BFC25');
  const status: CheckStatus = result.status === 0 ? 'passed' : blockedByAsr ? 'blocked' : 'failed';

  console.log(`[${status}] ${name} (${durationMs}ms)`);
  if (status !== 'passed') {
    const detail = output.trim().split(/\r?\n/).slice(-18).join('\n');
    console.log(detail);
  }

  return {
    name,
    status,
    exitCode: result.status,
    durationMs,
    command: [command, ...commandArgs].join(' '),
    cwd,
    blockedByAsr,
    spawnError,
    outputTail: output.trim().split(/\r?\n/).slice(-40),
  };
}

function summarize(checks: CheckResult[]): VerificationSummary {
  const failed = checks.filter((check) => check.status === 'failed');
  const blocked = checks.filter((check) => check.status === 'blocked');
  return {
    ok: failed.length === 0 && blocked.length === 0,
    passed: checks.filter((check) => check.status === 'passed').length,
    failed: failed.length,
    blocked: blocked.length,
  };
}

fs.mkdirSync(buildDir, { recursive: true });

function hostScriptArgs(scriptName: string): string[] {
  return [runHostNodeScript, path.join(repoRoot, 'scripts', scriptName)];
}

function localStaticUnitGateEnv(): EnvOverrides {
  if (
    process.env.KCW_CI_CHANGED_FILES ||
    process.env.CHANGED_FILES ||
    process.env.KCW_CI_FORCE_EVAL === '1' ||
    process.env.KCW_EVAL_REPLAY_RECORDS
  ) {
    return {};
  }
  return { KCW_CI_CHANGED_FILES: 'scripts/verify-mvp.ts' };
}

const checks: CheckConfig[] = [
  {
    name: 'frontend app.js syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'apps', 'windows-client', 'resources', 'app.js')],
  },
  {
    name: 'frontend app-composer-popover.js syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'apps', 'windows-client', 'resources', 'app-composer-popover.js')],
  },
  {
    name: 'start-mvp script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'start-mvp.ts')],
  },
  {
    name: 'status-mvp script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'status-mvp.ts')],
  },
  {
    name: 'stop-mvp script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'stop-mvp.ts')],
  },
  {
    name: 'audit-mvp script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'audit-mvp.ts')],
  },
  {
    name: 'demo-mvp script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'demo-mvp.ts')],
  },
  {
    name: 'mvp runtime smoke script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'smoke-mvp-runtime.ts')],
  },
  {
    name: 'kimi api smoke script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'smoke-kimi-api.ts')],
  },
  {
    name: 'live-mvp smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-live-mvp.mjs')],
  },
  {
    name: 'plan closed-loop smoke script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'smoke-plan-closed-loop.ts')],
  },
  {
    name: 'ui contract smoke script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'smoke-ui-contract.ts')],
  },
  {
    name: 'rendered ui smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-rendered-ui.mjs')],
  },
  {
    name: 'react scroll smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-react-scroll.ts')],
  },
  {
    name: 'react artifacts panel smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-react-artifacts-panel.ts')],
  },
  {
    name: 'react branches smoke script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'smoke-react-branches.ts')],
  },
  {
    name: 'windows client resource smoke script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'smoke-windows-client-resources.ts')],
  },
  {
    name: 'host operation smoke script syntax',
    command: nodeBin,
    commandArgs: [runHostNodeScript, '--', '--check', path.join(repoRoot, 'scripts', 'smoke-local-operations.ts')],
  },
  {
    name: 'ci static and unit gates',
    command: nodeBin,
    commandArgs: [runHostNodeScript, path.join(repoRoot, 'scripts', 'ci.ts')],
    extraEnv: localStaticUnitGateEnv(),
  },
  {
    name: 'host local operation smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-local-operations.ts'),
  },
  {
    name: 'mvp runtime lifecycle smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-mvp-runtime.ts'),
  },
  {
    name: 'plan closed-loop smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-plan-closed-loop.ts'),
  },
  {
    name: 'ui to host api contract smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-ui-contract.ts'),
  },
  {
    name: 'rendered browser ui smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-rendered-ui.mjs'),
  },
  {
    name: 'react timeline scroll smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-react-scroll.ts'),
  },
  {
    name: 'react artifacts panel smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-react-artifacts-panel.ts'),
  },
  {
    name: 'react branches smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-react-branches.ts'),
  },
  {
    name: 'windows client static resource smoke',
    command: nodeBin,
    commandArgs: hostScriptArgs('smoke-windows-client-resources.ts'),
  },
];

if (includeWindowsClient) {
  checks.push({
    name: 'native Windows client operation smoke',
    command: 'pwsh',
    commandArgs: [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      path.join(repoRoot, 'scripts', 'smoke-windows-client.ps1'),
    ],
    detectAsr: true,
  });
}

const results = checks.map(runCheck);
const summary = summarize(results);
const report = {
  ok: summary.ok,
  generatedAt: new Date().toISOString(),
  repoRoot,
  reportPath,
  scope: includeWindowsClient
    ? 'web-host-mvp-plus-native-windows-client'
    : 'web-host-mvp-default',
  summary,
  notes: includeWindowsClient
    ? []
    : [
        'Native Windows client window-level smoke is not run by default because this machine currently blocks locally built executables with Defender ASR. Run with --windows-client after allowing the exact exe path.',
      ],
  checks: results,
};

fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
console.log(`report: ${reportPath}`);

if (!summary.ok) {
  process.exit(1);
}
