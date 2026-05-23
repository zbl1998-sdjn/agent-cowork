import path from 'node:path';
import { createServer } from './server.js';
import { JsonlWriter } from './storage/jsonl-writer.js';
import { getSessionPath } from './storage/app-home.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const trustedRoot = path.resolve(process.env.TRUSTED_ROOT || process.cwd());

const server = createServer({
  trustedRoot,
  kimiApiKey: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY,
  kimiBaseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL,
  kimiApiTimeoutMs: Number(process.env.KIMI_API_TIMEOUT_MS || 60_000),
  kimiApiMaxTokens: Number(process.env.KIMI_API_MAX_TOKENS || 2048),
  kimiModel: process.env.KIMI_MODEL,
  journalWriter: new JsonlWriter(
    path.join(getSessionPath('default'), 'events.jsonl'),
  ),
});

server.listen(port, host, () => {
  // eslint-disable-next-line no-console
  console.log(`Kimi cowork host listening on http://${host}:${port}`);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `Kimi cowork host could not bind ${host}:${port}; set PORT to a free port and retry.`,
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.error('Kimi cowork host failed to start:', error);
  process.exit(1);
});

// Graceful shutdown: drain in-flight SSE / abort runs / close MCP, then exit.
let shuttingDown = false;
function gracefulExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  const done = () => process.exit(0);
  if (typeof server.shutdown === 'function') {
    server.shutdown({ timeoutMs: 10000 }).then(done, done);
  } else {
    server.close(done);
  }
}
process.once('SIGINT', gracefulExit);
process.once('SIGTERM', gracefulExit);
