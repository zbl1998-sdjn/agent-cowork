import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

function ensureDemoWorkspace(workspace) {
  fs.mkdirSync(path.join(workspace, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'finance'), { recursive: true });

  const samples = [
    [
      path.join(workspace, 'meeting-notes.md'),
      '# 会议纪要\n- 跟进采购合同\n- 汇总发票和付款周期\n',
    ],
    [
      path.join(workspace, 'contracts', 'sample-contract.txt'),
      'Contract draft. Party A, Party B, renewal date, payment terms.',
    ],
    [
      path.join(workspace, 'finance', 'invoices.csv'),
      'vendor,amount\nMoonshot,1280\nOffice,360\n',
    ],
  ];

  for (const [filePath, content] of samples) {
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, content, 'utf8');
    }
  }
}

function openBrowser(url) {
  if (process.env.NO_OPEN === '1') {
    return;
  }
  if (process.platform === 'win32') {
    const child = spawn('cmd', ['/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.dirname(scriptDir);
const buildDir = path.join(repoRoot, 'build');
const workspace = path.resolve(process.env.TRUSTED_ROOT || path.join(repoRoot, 'build', 'mvp-workspace'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3017);
const url = `http://${host}:${port}/`;
const runtimeFile = path.resolve(process.env.MVP_RUNTIME_FILE || path.join(buildDir, 'mvp-runtime.json'));
const auditPath = path.join(workspace, '.KimiCowork', 'audit', 'host-events.jsonl');

ensureDemoWorkspace(workspace);
fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });

const server = createServer({
  trustedRoot: workspace,
  journalWriter: new JsonlWriter(auditPath),
});

function writeRuntimeFile() {
  const runtime = {
    ok: true,
    pid: process.pid,
    host,
    port,
    url,
    workspace,
    auditPath,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
}

function removeRuntimeFile() {
  try {
    if (!fs.existsSync(runtimeFile)) {
      return;
    }
    const current = JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
    if (current.pid === process.pid) {
      fs.rmSync(runtimeFile, { force: true });
    }
  } catch {
    // Runtime status is best-effort; do not mask shutdown.
  }
}

function shutdown() {
  server.close(() => {
    removeRuntimeFile();
    process.exit(0);
  });
}

server.listen(port, host, () => {
  writeRuntimeFile();
  console.log(`Kimi Cowork MVP running at ${url}`);
  console.log(`Trusted workspace: ${workspace}`);
  console.log(`Runtime file: ${runtimeFile}`);
  console.log('Press Ctrl+C to stop.');
  openBrowser(url);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Port is busy: ${host}:${port}. Set PORT to a free port and retry.`);
    process.exit(1);
  }
  console.error('Failed to start Kimi Cowork MVP:', error);
  process.exit(1);
});

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('exit', removeRuntimeFile);
