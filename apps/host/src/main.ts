// 进程入口(host · L4 组装根 · main.ts)
// ---------------------------------------------------------------------------
// 职责:读环境变量装配并启动 HTTP 服务器(createServer),绑定回环地址(非回环会大声告警——本服务设计为
//       仅 loopback 的 sidecar),处理端口占用与启动失败,并在 SIGINT/SIGTERM 时优雅停机。
// 依赖:L4 server.ts + L1 storage(事件 jsonl 写入 / 会话路径) + L0 util。无导出(可执行入口)。
import path from 'node:path';
import { z } from 'zod';
import { createServer } from './server.js';
import type { McpServerSpec } from './mcp/connect.js';
import { getSessionPath } from './storage/app-home.js';
import { JsonlWriter } from './storage/jsonl-writer.js';
import { omitUndefined } from './util/object.js';
import { startParentWatchdog } from './util/parent-watchdog.js';
import {
  resolvePublicHost,
  withPublicHostSecurity,
} from './security/public-host-policy.js';

const envSchema = z.object({
  HOST: z.string().trim().min(1).catch('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65_535).catch(3001),
  TRUSTED_ROOT: z.string().trim().min(1).optional(),
  KIMI_API_KEY: z.string().optional(),
  MOONSHOT_API_KEY: z.string().optional(),
  KIMI_BASE_URL: z.string().optional(),
  MOONSHOT_BASE_URL: z.string().optional(),
  KIMI_API_TIMEOUT_MS: z.coerce.number().int().positive().catch(60_000),
  KIMI_API_MAX_TOKENS: z.coerce.number().int().positive().catch(2048),
  KIMI_MODEL: z.string().optional(),
  KCW_TAURI: z.literal('1').optional(),
  KCW_PARENT_PID: z.coerce.number().int().positive().optional().catch(undefined),
  MASE_MCP_ENABLED: z.string().optional(),
  MASE_REPO: z.string().optional(),
  MASE_CONFIG_PATH: z.string().optional(),
  MASE_MEMORY_DIR: z.string().optional(),
}).loose();

const env = envSchema.parse(process.env);
const host = resolvePublicHost(env.HOST);
const port = env.PORT;
const trustedRoot = path.resolve(env.TRUSTED_ROOT || process.cwd());

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value));
}

// MASE 长期记忆 MCP:启用时(MASE_MCP_ENABLED=1 且配置了 MASE_REPO)装配一条 stdio 连接器,
// host 启动即自动连接,记忆写入可写的 MASE_MEMORY_DIR(规避 E: 盘沙箱不可写的问题)。
function buildMaseMcpServers(): McpServerSpec[] {
  if (env.MASE_MCP_ENABLED !== '1' || !env.MASE_REPO) {
    return [];
  }
  const repo = env.MASE_REPO;
  return [
    {
      name: 'mase-memory',
      command: 'python',
      args: ['-m', 'integrations.mcp_server.server'],
      cwd: repo,
      env: omitUndefined({
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        PYTHONUTF8: '1',
        PYTHONPATH: `${repo};${repo}\\src`,
        MASE_CONFIG_PATH: env.MASE_CONFIG_PATH || `${repo}\\config.json`,
        MASE_MEMORY_DIR: env.MASE_MEMORY_DIR,
        MASE_ALLOW_CLOUD_MODELS: '0',
      }),
      timeoutMs: 60_000,
    },
  ];
}

const server = createServer(withPublicHostSecurity(omitUndefined({
  trustedRoot,
  allowLocalModelConfigSelfService: env.KCW_TAURI === '1' || undefined,
  allowLocalGuestEnrollment: env.KCW_TAURI === '1' || undefined,
  kimiApiKey: firstNonEmpty(env.KIMI_API_KEY, env.MOONSHOT_API_KEY),
  kimiBaseUrl: firstNonEmpty(env.KIMI_BASE_URL, env.MOONSHOT_BASE_URL),
  kimiApiTimeoutMs: env.KIMI_API_TIMEOUT_MS,
  kimiApiMaxTokens: env.KIMI_API_MAX_TOKENS,
  kimiModel: env.KIMI_MODEL,
  mcpServers: buildMaseMcpServers(),
  journalWriter: new JsonlWriter(
    path.join(getSessionPath('default'), 'events.jsonl'),
  ),
})));

async function start(): Promise<void> {
  try {
    await server.ready();
  } catch (error) {
    console.error('Agent cowork host dependencies failed to start:', error);
    process.exit(1);
  }

  server.listen(port, host, () => {
    console.log(`Agent cowork host listening on http://${host}:${port}`);
  });
}

void start().catch((error: unknown) => {
  console.error('Agent cowork host failed to start:', error);
  process.exit(1);
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(
      `Agent cowork host could not bind ${host}:${port}; set PORT to a free port and retry.`,
    );
    process.exit(1);
  }

  console.error('Agent cowork host failed to start:', error);
  process.exit(1);
});

// 优雅停机:排空 SSE、终止运行、关闭 MCP 后再退出。
let shuttingDown = false;
function gracefulExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  const done = () => process.exit(0);
  server.shutdown({ timeoutMs: 10000 }).then(done, done);
}
process.once('SIGINT', gracefulExit);
process.once('SIGTERM', gracefulExit);

// 父进程看门狗:作为桌面外壳的 sidecar 启动时(外壳传 KCW_PARENT_PID),父进程
// 消失(强杀/崩溃/关窗未及清理)即优雅退出,杜绝孤儿 host 常驻占 3017;
// 优雅停机卡住时 5s 兜底硬退。独立启动(npm start / start:mvp)不传该变量,不受影响。
if (env.KCW_PARENT_PID) {
  startParentWatchdog({
    parentPid: env.KCW_PARENT_PID,
    onParentGone: () => {
      console.error(`[host] parent process ${env.KCW_PARENT_PID} is gone; shutting down to avoid an orphaned sidecar.`);
      const hardExit: ReturnType<typeof setTimeout> = setTimeout(() => process.exit(0), 5000);
      (hardExit as unknown as { unref?: () => void }).unref?.();
      gracefulExit();
    },
  });
}
