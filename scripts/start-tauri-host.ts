// 为 Tauri 桌面端启动 Node Host API 服务(scripts · MVP生命周期)
// ---------------------------------------------------------------------------
// 职责:加载仓库根 .env(KIMI_API_KEY 等,Node ≥ 20.12 用 loadEnvFile,无文件则回退现有环境),
//       以 TRUSTED_ROOT(默认仓库根)为受信根拉起 Host HTTP 服务(默认 127.0.0.1:3017),
//       审计事件写入应用主目录 tauri 会话的 events.jsonl;监听 SIGINT/SIGTERM 优雅关闭。
// 用法:npm run start:tauri-host;开发态由 start-tauri-dev.ts 作为子进程启动,
//       供 Tauri React UI 调用其后端 API;可用 HOST/PORT/TRUSTED_ROOT 及 KIMI_* 环境变量调整。
// 依赖:apps/host 的 createServer、JsonlWriter 与 getSessionPath(应用主目录会话路径)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';
import { getSessionPath } from '../apps/host/src/storage/app-home.js';

type ProcessWithLoadEnvFile = typeof process & {
  loadEnvFile(path: string): void;
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const processWithEnvFile = process as ProcessWithLoadEnvFile;
// Load repo-root .env (KIMI_API_KEY etc.) if present; Node >= 20.12 has loadEnvFile.
try {
  processWithEnvFile.loadEnvFile(path.join(repoRoot, '.env'));
} catch {
  // No .env: fall back to the process environment provided by Tauri/dev shell.
}
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3017);
const trustedRoot = path.resolve(process.env.TRUSTED_ROOT || repoRoot);

const server = createServer({
  trustedRoot,
  kimiApiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY,
  kimiBaseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL,
  kimiApiTimeoutMs: Number(process.env.KIMI_API_TIMEOUT_MS || 60_000),
  kimiApiMaxTokens: Number(process.env.KIMI_API_MAX_TOKENS || 2048),
  kimiModel: process.env.KIMI_MODEL,
  kimiUserAgent: process.env.KIMI_USER_AGENT,
  kimiTemperature: process.env.KIMI_TEMPERATURE,
  journalWriter: new JsonlWriter(path.join(getSessionPath('tauri'), 'events.jsonl')),
});

server.listen(port, host, () => {
  console.log(`Agent Cowork Tauri host listening on http://${host}:${port}`);
});

server.on('error', (error) => {
  console.error('Agent Cowork Tauri host failed to start:', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
