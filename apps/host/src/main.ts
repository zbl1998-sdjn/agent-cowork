// 进程入口(host · L4 组装根 · main.ts)
// ---------------------------------------------------------------------------
// 职责:读环境变量装配并启动 HTTP 服务器(createServer),绑定回环地址(非回环会大声告警——本服务设计为
//       仅 loopback 的 sidecar),处理端口占用与启动失败,并在 SIGINT/SIGTERM 时优雅停机。
// 依赖:L4 server.ts + L1 storage(事件 jsonl 写入 / 会话路径) + L0 util。无导出(可执行入口)。
import path from 'node:path';
import { z } from 'zod';
import { createServer } from './server.js';
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
}).loose();

const env = envSchema.parse(process.env);
const host = env.HOST;
const port = env.PORT;
const trustedRoot = path.resolve(env.TRUSTED_ROOT || process.cwd());

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find((value): value is string => Boolean(value));
}

// CFG-1: the host is designed as a loopback-only sidecar. Binding to a routable
// address exposes the agent's file/sandbox/API surface to the network — warn
// loudly so an accidental `HOST=0.0.0.0` never goes unnoticed.
const isLoopbackBind = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host.toLowerCase());
if (!isLoopbackBind) {
  console.warn(
    `[host] WARNING: binding to non-loopback address "${host}" exposes the local agent API to the network. ` +
    'Ensure authentication is enforced and set KCW_VALIDATE_HOST=false only if you intend remote access.',
  );
}

// CFG-2: trusting client-supplied identity headers lets any caller that reaches
// the server impersonate any tenant/user. It's off by default; if it's ever on,
// say so loudly — it is only safe behind a reverse proxy that strips these
// headers from external clients.
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

// Graceful shutdown: drain in-flight SSE / abort runs / close MCP, then exit.
let shuttingDown = false;
function gracefulExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  const done = () => process.exit(0);
  server.shutdown({ timeoutMs: 10000 }).then(done, done);
}
process.once('SIGINT', gracefulExit);
process.once('SIGTERM', gracefulExit);
