import path from 'node:path';
import { createServer } from './server.js';
import { JsonlWriter } from './storage/jsonl-writer.js';
import { getSessionPath } from './storage/app-home.js';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3001);
const trustedRoot = path.resolve(process.env.TRUSTED_ROOT || process.cwd());

const server = createServer({
  trustedRoot,
  kimiExecutable: process.env.KIMI_CLI || 'kimi',
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

process.once('SIGINT', () => {
  server.close(() => {
    process.exit(0);
  });
});
