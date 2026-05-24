import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildDir = path.join(repoRoot, 'build');
const nodeBin = process.execPath;
const args = new Set(process.argv.slice(2));
const includeWindowsClient =
  args.has('--windows-client') || process.env.VERIFY_WINDOWS_CLIENT === '1';
const reportPath = path.join(
  buildDir,
  includeWindowsClient ? 'mvp-verification-report-windows.json' : 'mvp-verification-report.json',
);

function runCheck({ name, command, commandArgs, cwd = repoRoot, detectAsr = false }) {
  const startedAt = Date.now();
  const result = spawnSync(command, commandArgs, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1' },
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
  const status = result.status === 0 ? 'passed' : blockedByAsr ? 'blocked' : 'failed';

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

function summarize(checks) {
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

const checks = [
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
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'start-mvp.mjs')],
  },
  {
    name: 'status-mvp script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'status-mvp.mjs')],
  },
  {
    name: 'stop-mvp script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'stop-mvp.mjs')],
  },
  {
    name: 'audit-mvp script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'audit-mvp.mjs')],
  },
  {
    name: 'demo-mvp script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'demo-mvp.mjs')],
  },
  {
    name: 'mvp runtime smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-mvp-runtime.mjs')],
  },
  {
    name: 'kimi api smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-kimi-api.mjs')],
  },
  {
    name: 'live-mvp smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-live-mvp.mjs')],
  },
  {
    name: 'plan closed-loop smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-plan-closed-loop.mjs')],
  },
  {
    name: 'ui contract smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-ui-contract.mjs')],
  },
  {
    name: 'rendered ui smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-rendered-ui.mjs')],
  },
  {
    name: 'react scroll smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-react-scroll.mjs')],
  },
  {
    name: 'react artifacts panel smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-react-artifacts-panel.mjs')],
  },
  {
    name: 'react branches smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-react-branches.mjs')],
  },
  {
    name: 'windows client resource smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-windows-client-resources.mjs')],
  },
  {
    name: 'host operation smoke script syntax',
    command: nodeBin,
    commandArgs: ['--check', path.join(repoRoot, 'scripts', 'smoke-local-operations.mjs')],
  },
  {
    name: 'ci static and unit gates',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'ci.mjs')],
  },
  {
    name: 'host local operation smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-local-operations.mjs')],
  },
  {
    name: 'mvp runtime lifecycle smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-mvp-runtime.mjs')],
  },
  {
    name: 'plan closed-loop smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-plan-closed-loop.mjs')],
  },
  {
    name: 'ui to host api contract smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-ui-contract.mjs')],
  },
  {
    name: 'rendered browser ui smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-rendered-ui.mjs')],
  },
  {
    name: 'react timeline scroll smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-react-scroll.mjs')],
  },
  {
    name: 'react artifacts panel smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-react-artifacts-panel.mjs')],
  },
  {
    name: 'react branches smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-react-branches.mjs')],
  },
  {
    name: 'windows client static resource smoke',
    command: nodeBin,
    commandArgs: [path.join(repoRoot, 'scripts', 'smoke-windows-client-resources.mjs')],
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
