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
  KCW_TRUST_IDENTITY_HEADERS: z.string().optional(),
  MASE_MCP_ENABLED: z.string().optional(),
  MASE_REPO: z.string().optional(),
  MASE_CONFIG_PATH: z.string().optional(),
  MASE_MEMORY_DIR: z.string().optional(),
}).loose();

const env = envSchema.parse(process.env);
const host = env.HOST;
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

// CFG-1:host 被设计为仅回环 sidecar;绑定可路由地址会把文件/沙箱/API 面暴露到网络。
// 因此对 HOST=0.0.0.0 这类配置大声告警,避免误开远程入口。
const isLoopbackBind = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
if (!isLoopbackBind) {
  console.warn(
    `[host] WARNING: binding to non-loopback address "${host}" exposes the local agent API to the network. ` +
    'Ensure authentication is enforced and set KCW_VALIDATE_HOST=false only if you intend remote access.',
  );
}

// CFG-2:信任客户端身份头会允许任何能连到服务的调用者冒充任意 tenant/user。
// 默认关闭;只有在会剥离外部身份头的反向代理之后才可开启,开启时必须告警。
if (env.KCW_TRUST_IDENTITY_HEADERS === 'true') {
  console.warn(
    '[host] WARNING: KCW_TRUST_IDENTITY_HEADERS=true trusts client-supplied x-tenant-id/x-user-id headers ' +
    '(any caller can impersonate any tenant). Only enable this behind a reverse proxy that strips these ' +
    'headers from external clients; never expose such an instance directly.',
  );
}

const server = createServer(omitUndefined({
  trustedRoot,
  kimiApiKey: firstNonEmpty(env.KIMI_API_KEY, env.MOONSHOT_API_KEY),
  kimiBaseUrl: firstNonEmpty(env.KIMI_BASE_URL, env.MOONSHOT_BASE_URL),
  kimiApiTimeoutMs: env.KIMI_API_TIMEOUT_MS,
  kimiApiMaxTokens: env.KIMI_API_MAX_TOKENS,
  kimiModel: env.KIMI_MODEL,
  mcpServers: buildMaseMcpServers(),
  journalWriter: new JsonlWriter(
    path.join(getSessionPath('default'), 'events.jsonl'),
  ),
}));

server.listen(port, host, () => {
  console.log(`Agent cowork host listening on http://${host}:${port}`);
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
