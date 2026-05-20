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
const workspace = path.resolve(process.env.TRUSTED_ROOT || path.join(repoRoot, 'build', 'mvp-workspace'));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3017);
const url = `http://${host}:${port}/`;

ensureDemoWorkspace(workspace);

const server = createServer({
  trustedRoot: workspace,
  journalWriter: new JsonlWriter(path.join(workspace, '.KimiCowork', 'audit', 'host-events.jsonl')),
});

server.listen(port, host, () => {
  console.log(`Kimi Cowork MVP running at ${url}`);
  console.log(`Trusted workspace: ${workspace}`);
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

process.once('SIGINT', () => {
  server.close(() => {
    process.exit(0);
  });
});
