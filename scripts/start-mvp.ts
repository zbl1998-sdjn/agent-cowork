// 启动本地 MVP Host 服务并打开浏览器演示(scripts · MVP生命周期)
// ---------------------------------------------------------------------------
// 职责:在 build/mvp-workspace 下铺好演示工作区(示例合同/发票/会议纪要),
//       以该目录为受信根(trustedRoot)拉起 Host HTTP 服务(默认 127.0.0.1:3017),
//       写入 build/mvp-runtime.json 运行时状态(pid/host/port/url/审计路径等),
//       并自动打开浏览器;收到 SIGINT/SIGTERM 时优雅关闭并清理运行时文件。
// 用法:npm run start:mvp(即 node scripts/run-host-node.mjs scripts/start-mvp.ts);
//       可用环境变量 PORT/TRUSTED_ROOT/MVP_RUNTIME_FILE、NO_OPEN=1 覆盖默认行为;HOST 仅接受回环地址;
//       配置 ACW_MODEL_API_KEY(或 KIMI_API_KEY/MOONSHOT_API_KEY)后启用模型计划能力(默认仅会议纪要演示)。
// 依赖:apps/host 的 createServer 与 JsonlWriter;与 stop-mvp.ts/status-mvp.ts 共享运行时文件契约。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  resolvePublicHost,
  withPublicHostSecurity,
} from '../apps/host/src/security/public-host-policy.js';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';

type RuntimeFileState = {
  pid?: unknown;
};

function ensureDemoWorkspace(workspace: string): void {
  fs.mkdirSync(path.join(workspace, 'contracts'), { recursive: true });
  fs.mkdirSync(path.join(workspace, 'finance'), { recursive: true });

  const samples: Array<[filePath: string, content: string]> = [
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

function openBrowser(url: string): void {
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
const host = resolvePublicHost(process.env.HOST);
const port = Number(process.env.PORT || 3017);
const url = `http://${host}:${port}/`;
const runtimeFile = path.resolve(process.env.MVP_RUNTIME_FILE || path.join(buildDir, 'mvp-runtime.json'));
const auditPath = path.join(workspace, '.AgentCowork', 'audit', 'host-events.jsonl');
const modelApiPlanEnabled = Boolean(process.env.ACW_MODEL_API_KEY || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY);

ensureDemoWorkspace(workspace);
fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });

const server = createServer(withPublicHostSecurity({
  trustedRoot: workspace,
  allowLocalModelConfigSelfService: true,
  allowLocalGuestEnrollment: true,
  modelApiKey: process.env.ACW_MODEL_API_KEY || process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY,
  modelBaseUrl: process.env.ACW_MODEL_BASE_URL || process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL,
  modelApiTimeoutMs: Number(process.env.ACW_MODEL_API_TIMEOUT_MS || process.env.KIMI_API_TIMEOUT_MS || 60_000),
  modelApiMaxTokens: Number(process.env.ACW_MODEL_API_MAX_TOKENS || process.env.KIMI_API_MAX_TOKENS || 2048),
  model: process.env.ACW_MODEL || process.env.KIMI_MODEL,
  journalWriter: new JsonlWriter(auditPath),
}));

function writeRuntimeFile(): void {
  const runtime = {
    ok: true,
    pid: process.pid,
    host,
    port,
    url,
    workspace,
    auditPath,
    modelApiPlanEnabled,
    startedAt: new Date().toISOString(),
  };
  fs.writeFileSync(runtimeFile, `${JSON.stringify(runtime, null, 2)}\n`, 'utf8');
}

function removeRuntimeFile(): void {
  try {
    if (!fs.existsSync(runtimeFile)) {
      return;
    }
    const current = JSON.parse(fs.readFileSync(runtimeFile, 'utf8')) as RuntimeFileState;
    if (current.pid === process.pid) {
      fs.rmSync(runtimeFile, { force: true });
    }
  } catch {
    // Runtime status is best-effort; do not mask shutdown.
  }
}

function shutdown(): void {
  server.close(() => {
    removeRuntimeFile();
    process.exit(0);
  });
}

server.listen(port, host, () => {
  writeRuntimeFile();
  console.log(`Agent Cowork MVP running at ${url}`);
  console.log(`Trusted workspace: ${workspace}`);
  console.log(`Model API plan: ${modelApiPlanEnabled ? 'enabled' : 'not configured'}`);
  console.log(`Runtime file: ${runtimeFile}`);
  console.log('Press Ctrl+C to stop.');
  openBrowser(url);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    console.error(`Port is busy: ${host}:${port}. Set PORT to a free port and retry.`);
    process.exit(1);
  }
  console.error('Failed to start Agent Cowork MVP:', error);
  process.exit(1);
});

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('exit', removeRuntimeFile);
