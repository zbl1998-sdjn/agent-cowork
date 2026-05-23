import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';
import { getSessionPath } from '../apps/host/src/storage/app-home.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
// Load repo-root .env (KIMI_API_KEY etc.) if present; Node >= 20.12 has loadEnvFile.
try { process.loadEnvFile(path.join(repoRoot, '.env')); } catch { /* no .env: fall back to process env */ }
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
  console.log(`Kimi Cowork Tauri host listening on http://${host}:${port}`);
});

server.on('error', (error) => {
  console.error('Kimi Cowork Tauri host failed to start:', error);
  process.exit(1);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    server.close(() => process.exit(0));
  });
}
