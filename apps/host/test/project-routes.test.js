import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { makeTestWorkspace } from './test-fixtures.js';

async function withServer(config, fn) {
  const server = createServer(config);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function registerUser(baseUrl, username) {
  const res = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'passw0rd' }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).token;
}

async function jsonRequest(baseUrl, route, { method = 'GET', token, body, idem } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idem) headers['idempotency-key'] = idem;
  const res = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

test('project routes scope projects per signed-in user and manage memberships', async () => {
  const trustedRoot = makeTestWorkspace('kcw-project-routes');
  await withServer({ trustedRoot }, async (baseUrl) => {
    const tokenA = await registerUser(baseUrl, 'project-alice');
    const tokenB = await registerUser(baseUrl, 'project-bob');

    let res = await jsonRequest(baseUrl, '/api/projects', {
      method: 'POST',
      token: tokenA,
      idem: 'proj-create-1',
      body: { name: '客户 A', color: '#2563eb' },
    });
    assert.equal(res.status, 200);
    const project = res.body.project;
    assert.equal(project.name, '客户 A');
    assert.deepEqual(project.stats, { conversations: 0, artifacts: 0 });

    res = await jsonRequest(baseUrl, `/api/projects/${project.id}/conversations`, {
      method: 'POST',
      token: tokenA,
      idem: 'proj-conv-1',
      body: { conversationId: 'conv_1' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.project.conversations, ['conv_1']);

    res = await jsonRequest(baseUrl, `/api/projects/${project.id}/artifacts`, {
      method: 'POST',
      token: tokenA,
      idem: 'proj-art-1',
      body: { artifactId: 'artifact_1' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.project.stats, { conversations: 1, artifacts: 1 });

    res = await jsonRequest(baseUrl, `/api/projects/${project.id}`, { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.project.artifacts, ['artifact_1']);

    res = await jsonRequest(baseUrl, '/api/projects', { token: tokenB });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.projects, []);

    res = await jsonRequest(baseUrl, `/api/projects/${project.id}`, {
      method: 'PATCH',
      token: tokenA,
      idem: 'proj-archive-1',
      body: { archived: true },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.project.archived, true);

    res = await jsonRequest(baseUrl, '/api/projects', { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.projects, []);
    res = await jsonRequest(baseUrl, '/api/projects?includeArchived=1', { token: tokenA });
    assert.equal(res.body.projects[0].archived, true);

    res = await jsonRequest(baseUrl, `/api/projects/${project.id}`, {
      method: 'DELETE',
      token: tokenA,
      idem: 'proj-delete-1',
      body: {},
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.deleted, true);
  });
});

test('project routes reject trustedRoot outside the configured jail', async () => {
  const trustedRoot = makeTestWorkspace('kcw-project-jail');
  await withServer({ trustedRoot, requireAuth: false }, async (baseUrl) => {
    const res = await jsonRequest(baseUrl, '/api/projects?trustedRoot=C:/', {});
    assert.equal(res.status, 400);
    assert.match(res.body.error, /trusted root/i);
  });
});
