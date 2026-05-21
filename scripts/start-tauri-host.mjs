import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import { JsonlWriter } from '../apps/host/src/storage/jsonl-writer.js';
import { getSessionPath } from '../apps/host/src/storage/app-home.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3017);
const trustedRoot = path.resolve(process.env.TRUSTED_ROOT || repoRoot);

const server = createServer({
  trustedRoot,
  kimiExecutable: process.env.KIMI_CLI || 'kimi',
  enableKimiCliPlan: process.env.ENABLE_KIMI_CLI_PLAN === '1',
  kimiCliTimeoutMs: Number(process.env.KIMI_CLI_TIMEOUT_MS || 60_000),
  kimiCliMaxSteps: Number(process.env.KIMI_CLI_MAX_STEPS || 10),
  kimiModel: process.env.KIMI_MODEL,
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
