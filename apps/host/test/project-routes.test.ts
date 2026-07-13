import assert from 'node:assert/strict';
import test from 'node:test';
import type { AddressInfo } from 'node:http';
import { sendJson } from '../src/http/request-utils.js';
import { handleProjectRoutes } from '../src/routes/project-routes.js';
import { createServer } from '../src/server.js';
import { createUserStore } from '../src/auth/user-store.js';
import { createProjectStore } from '../src/storage/projects.js';
import { makeTestWorkspace } from './test-fixtures.js';
import type { HttpRequestLike, HttpResponseLike } from '../src/http/request-utils.js';
import type { ProjectStore } from '../src/storage/projects.js';

type ServerConfig = Parameters<typeof createServer>[0];
type JsonRequestOptions = { method?: string; token?: string; body?: unknown; idem?: string };
type JsonResponse<T> = { status: number; body: T };
type ProjectRecord = {
  id: string;
  name?: string;
  archived?: boolean;
  artifacts?: string[];
  conversations?: string[];
  stats?: unknown;
};
type ProjectRoutesBody = {
  deleted?: boolean;
  error?: string;
  project: ProjectRecord;
  projects: ProjectRecord[];
};
type JsonRecord = Record<string, unknown>;
type RequestListener = (...args: unknown[]) => void;
type SupportedRequestListener = RequestListener | ((chunk: Buffer | string) => void) | (() => void) | ((error: Error) => void);
type CapturedResponse = HttpResponseLike & { status: number; body: string; json(): JsonRecord };
type CachedWrite = { fingerprint: string; status: number; payload: unknown };

class FakeJsonRequest implements HttpRequestLike {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  private readonly listeners = new Map<string, RequestListener[]>();

  constructor(method: string, private readonly body?: unknown) {
    this.method = method;
    this.headers = body === undefined ? {} : { 'content-type': 'application/json' };
    void Promise.resolve().then(() => {
      if (this.body !== undefined) this.emit('data', Buffer.from(JSON.stringify(this.body)));
      this.emit('end');
    });
  }

  on(event: 'data', listener: (chunk: Buffer | string) => void): this;
  on(event: 'end', listener: () => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: string, listener: RequestListener): this;
  on(event: string, listener: SupportedRequestListener): this {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener as RequestListener);
    this.listeners.set(event, listeners);
    return this;
  }

  resume(): void {
    // Test request bodies are emitted eagerly; there is nothing to drain.
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) || []) listener(...args);
  }
}

function capturedResponse(): CapturedResponse {
  return {
    status: 0,
    body: '',
    writeHead(statusCode) {
      this.status = statusCode;
    },
    end(chunk = '') {
      this.body = String(chunk);
    },
    json() {
      const parsed = JSON.parse(this.body || '{}') as unknown;
      assert.ok(parsed && typeof parsed === 'object' && !Array.isArray(parsed), 'captured response body should be an object');
      return parsed as JsonRecord;
    },
  };
}

function objectField(source: JsonRecord, key: string, label = key): JsonRecord {
  const value = source[key];
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} should be an object`);
  return value as JsonRecord;
}

function stringArrayField(source: JsonRecord, key: string, label = key): string[] {
  const value = source[key];
  assert.ok(Array.isArray(value), `${label} should be an array`);
  for (const [index, item] of value.entries()) {
    assert.equal(typeof item, 'string', `${label}[${index}] should be a string`);
  }
  return value as string[];
}

function createProjectRouteHarness(store: ProjectStore = createProjectStore({ now: () => 1_700_000_000_000 })) {
  const root = makeTestWorkspace('kcw-project-direct');
  const cache = new Map<string, CachedWrite>();
  let sequence = 0;
  return {
    root,
    store,
    async call(method: string, route: string, body?: unknown): Promise<{ handled: boolean; response: CapturedResponse }> {
      const requestUrl = new URL(`http://local${route}`);
      const response = capturedResponse();
      sequence += 1;
      const handled = await handleProjectRoutes({
        request: new FakeJsonRequest(method, body),
        response,
        pathname: requestUrl.pathname,
        requestUrl,
        requestContext: {
          tenantId: 'tenant-direct',
          userId: 'user-direct',
          traceId: `trace-${sequence}`,
          idempotencyKey: `idem-${sequence}`,
        },
        trustedRootDefault: root,
        safeTrustedRoot(input?: unknown) {
          const candidate = String(input || root);
          if (candidate !== root) {
            const error = new Error('trusted root outside configured jail') as Error & { statusCode?: number };
            error.statusCode = 422;
            throw error;
          }
          return root;
        },
        getProjectStore: () => store,
        cacheKeyFor: (context, methodName = '', pathname = '') => `${context.tenantId}:${context.userId}:${methodName}:${pathname}:${context.idempotencyKey}`,
        requireIdempotencyKey(res, context) {
          if (!context.idempotencyKey) {
            sendJson(res, 428, { error: 'Idempotency-Key required' });
            return false;
          }
          return true;
        },
        sendCachedOrStore(res, cacheKey, fingerprint, status, payload) {
          const cached = cache.get(cacheKey);
          if (payload === undefined) {
            if (!cached) return false;
            if (cached.fingerprint !== fingerprint) {
              sendJson(res, 409, { error: 'Idempotency-Key conflict' });
              return true;
            }
            sendJson(res, cached.status, cached.payload);
            return true;
          }
          cache.set(cacheKey, { fingerprint, status, payload });
          sendJson(res, status, payload);
          return true;
        },
      });
      return { handled, response };
    },
  };
}

function createMissingProjectMembershipStore(): ProjectStore {
  return {
    create: () => {
      throw new Error('unexpected create');
    },
    rename: () => {
      throw new Error('unexpected rename');
    },
    setColor: () => {
      throw new Error('unexpected setColor');
    },
    archive: () => {
      throw new Error('unexpected archive');
    },
    unarchive: () => {
      throw new Error('unexpected unarchive');
    },
    remove: () => false,
    get: () => null,
    list: () => {
      throw new Error('list failed');
    },
    assignConversation: () => undefined,
    unassignConversation: () => true,
    projectOfConversation: () => null,
    conversationsOf: () => [],
    assignArtifact: () => undefined,
    unassignArtifact: () => true,
    artifactsOf: () => [],
    stats: () => {
      throw new Error('unexpected stats');
    },
  };
}

async function withServer(config: ServerConfig, fn: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createServer(config);
  await new Promise<void>((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address !== null);
  assert.equal(typeof address, 'object');
  const { port } = address as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function jsonRequest<T = ProjectRoutesBody>(
  baseUrl: string,
  route: string,
  { method = 'GET', token, body, idem }: JsonRequestOptions = {},
): Promise<JsonResponse<T>> {
  const headers: Record<string, string> = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (idem) headers['idempotency-key'] = idem;
  const init: RequestInit = { method, headers };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(`${baseUrl}${route}`, init);
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

test('project routes scope projects per signed-in user and manage memberships', async () => {
  const trustedRoot = makeTestWorkspace('kcw-project-routes');
  const authStore = createUserStore();
  const tokenA = authStore.createSession(authStore.register('project-alice', 'passw0rd'));
  const tokenB = authStore.createSession(authStore.register('project-bob', 'passw0rd'));
  await withServer({ trustedRoot, authStore }, async (baseUrl) => {

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

    res = await jsonRequest(baseUrl, `/api/projects/${project.id}/conversations`, {
      method: 'POST',
      token: tokenA,
      idem: 'proj-conv-malformed',
      body: { conversationId: ['conv_bad'] },
    });
    assert.equal(res.status, 400);

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

    res = await jsonRequest(baseUrl, `/api/projects/${project.id}`, {
      method: 'PATCH',
      token: tokenA,
      idem: 'proj-archive-malformed',
      body: { archived: 'false' },
    });
    assert.equal(res.status, 400);

    res = await jsonRequest(baseUrl, '/api/projects', { token: tokenA });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.projects, []);
    res = await jsonRequest(baseUrl, '/api/projects?includeArchived=1', { token: tokenA });
    const firstProject = res.body.projects[0];
    assert.ok(firstProject);
    assert.equal(firstProject.archived, true);

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
    assert.ok(res.body.error);
    assert.match(res.body.error, /trusted root/i);
  });
});

test('project route direct handlers preserve project and membership behavior', async () => {
  const route = createProjectRouteHarness();

  let result = await route.call('POST', '/api/projects', { name: 'Direct Project', color: '#0f766e' });
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  let project = objectField(result.response.json(), 'project');
  assert.equal(project.name, 'Direct Project');
  assert.equal(project.color, '#0f766e');
  const projectId = String(project.id);

  result = await route.call('PATCH', `/api/projects/${projectId}`, { name: 'Renamed', color: null, archived: false });
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  project = objectField(result.response.json(), 'project');
  assert.equal(project.name, 'Renamed');
  assert.equal(project.color, null);
  assert.equal(project.archived, false);

  result = await route.call('POST', `/api/projects/${projectId}/conversations`, { conversationId: 'conv-direct' });
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  project = objectField(result.response.json(), 'project');
  assert.deepEqual(stringArrayField(project, 'conversations'), ['conv-direct']);

  result = await route.call('POST', `/api/projects/${projectId}/artifacts`, { artifactId: 'artifact-direct' });
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  project = objectField(result.response.json(), 'project');
  assert.deepEqual(stringArrayField(project, 'artifacts'), ['artifact-direct']);

  result = await route.call('DELETE', `/api/projects/${projectId}/conversations/conv-direct`, {});
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.json().removed, true);

  result = await route.call('DELETE', `/api/projects/${projectId}/artifacts/artifact-direct`, {});
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.json().removed, true);

  result = await route.call('DELETE', `/api/projects/${projectId}`, {});
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.json().deleted, true);

  result = await route.call('GET', `/api/projects/${projectId}`);
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 404);
  assert.match(String(result.response.json().error), /not found/i);

  result = await route.call('PATCH', `/api/projects/${projectId}`, { name: 'missing' });
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 400);
  assert.match(String(result.response.json().error), /not found/i);
});

test('project route error paths fail closed for invalid roots, malformed ids, and missing memberships', async () => {
  let route = createProjectRouteHarness();

  let result = await route.call('GET', '/api/projects?trustedRoot=bad-root');
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 422);
  assert.match(String(result.response.json().error), /trusted root/i);

  result = await route.call('GET', '/api/projects/%E0%A4%A');
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 400);
  assert.match(String(result.response.json().error), /invalid project route/i);

  result = await route.call('DELETE', '/api/projects/proj_1/conversations/%E0%A4%A', {});
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 400);
  assert.match(String(result.response.json().error), /invalid project route/i);

  route = createProjectRouteHarness(createMissingProjectMembershipStore());

  result = await route.call('GET', '/api/projects');
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 400);
  assert.match(String(result.response.json().error), /list failed/);

  result = await route.call('POST', '/api/projects/missing/conversations', { conversationId: 'conv-lost' });
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 400);
  assert.match(String(result.response.json().error), /project not found/i);

  result = await route.call('POST', '/api/projects/missing/artifacts', { artifactId: 'artifact-lost' });
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 400);
  assert.match(String(result.response.json().error), /project not found/i);

  result = await route.call('DELETE', '/api/projects/missing/conversations/conv-lost', {});
  assert.equal(result.handled, true);
  assert.equal(result.response.status, 200);
  assert.equal(result.response.json().removed, true);
  assert.equal(result.response.json().project, null);

  result = await route.call('PATCH', '/api/projects/missing/conversations');
  assert.equal(result.handled, false);
  assert.equal(result.response.status, 0);
});
