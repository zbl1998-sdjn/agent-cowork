import assert from 'node:assert/strict';
import { createServer } from './src/server.js';
import { makeTestWorkspace } from './test/test-fixtures.js';

type BoundAddress = {
  port: number;
};

type RegisterResponse = {
  token: string;
};

function parseRegisterResponse(value: unknown): RegisterResponse {
  if (
    typeof value === 'object'
    && value != null
    && 'token' in value
    && typeof value.token === 'string'
  ) {
    return { token: value.token };
  }
  throw new Error('[dbg-del] auth register response did not include a token');
}

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      assert.ok(address && typeof address === 'object', 'debug server should bind to a TCP port');
      resolve(`http://127.0.0.1:${(address as BoundAddress).port}`);
    });
  });
}

function close(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error?: Error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

const trustedRoot = makeTestWorkspace('kcw-dbg-del');
const server = createServer({ trustedRoot });
try {
  const base = await listen(server);
  const registerResponse = await fetch(`${base}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'zoe', password: 'dummy-password' }),
  });
  const reg = parseRegisterResponse(await registerResponse.json());
  const auth = { authorization: `Bearer ${reg.token}`, 'content-type': 'application/json' };
  await fetch(`${base}/api/conversations/c1`, {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({ title: 't', messages: [] }),
  });
  const del = await fetch(`${base}/api/conversations/c1`, { method: 'DELETE', headers: auth });
  console.log('DELETE status', del.status);
  console.log('DELETE body', await del.text());
} finally {
  await close(server);
}
