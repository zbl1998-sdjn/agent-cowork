import path from 'node:path';
import { createServer } from './server.js';
import { JsonlWriter } from './storage/jsonl-writer.js';
import { getSessionPath } from './storage/app-home.js';

// @ts-check

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const trustedRoot = path.resolve(process.env.TRUSTED_ROOT || process.cwd());

// CFG-1: the host is designed as a loopback-only sidecar. Binding to a routable
// address exposes the agent's file/sandbox/API surface to the network — warn
// loudly so an accidental `HOST=0.0.0.0` never goes unnoticed.
const isLoopbackBind = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host).toLowerCase());
if (!isLoopbackBind) {
  // eslint-disable-next-line no-console
  console.warn(
    `[host] WARNING: binding to non-loopback address "${host}" exposes the local agent API to the network. ` +
    'Ensure authentication is enforced and set KCW_VALIDATE_HOST=false only if you intend remote access.',
  );
}

// CFG-2: trusting client-supplied identity headers lets any caller that reaches
// the server impersonate any tenant/user. It's off by default; if it's ever on,
// say so loudly — it is only safe behind a reverse proxy that strips these
// headers from external clients.
if (process.env.KCW_TRUST_IDENTITY_HEADERS === 'true') {
  // eslint-disable-next-line no-console
  console.warn(
    '[host] WARNING: KCW_TRUST_IDENTITY_HEADERS=true trusts client-supplied x-tenant-id/x-user-id headers ' +
    '(any caller can impersonate any tenant). Only enable this behind a reverse proxy that strips these ' +
    'headers from external clients; never expose such an instance directly.',
  );
}

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
  console.log(`Agent cowork host listening on http://${host}:${port}`);
});

server.on('error', (error) => {
  if (error && error.code === 'EADDRINUSE') {
    // eslint-disable-next-line no-console
    console.error(
      `Agent cowork host could not bind ${host}:${port}; set PORT to a free port and retry.`,
    );
    process.exit(1);
  }

  // eslint-disable-next-line no-console
  console.error('Agent cowork host failed to start:', error);
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
