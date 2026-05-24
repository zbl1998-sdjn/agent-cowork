import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

type FetchCall = {
  url: string;
  init?: RequestInit;
};

const encoder = new TextEncoder();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function sseResponse(frames: string): Response {
  const body = frames.endsWith('\n\n') ? frames : `${frames}\n\n`;
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(body));
      controller.close();
    },
  }), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function setStorage(initial: Record<string, string> = {}): void {
  const values = new Map(Object.entries(initial));
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
  });
}

async function importApi(
  handler?: (url: string, init?: RequestInit) => Response | Promise<Response>,
): Promise<{ api: typeof import('./api'); calls: FetchCall[] }> {
  vi.resetModules();
  setStorage();
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    calls.push({ url, init });
    if (handler) return handler(url, init);
    if (url.endsWith('/health')) return jsonResponse({ ok: true });
    return jsonResponse({ ok: true });
  });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  const api = await import('./api');
  return { api, calls };
}

async function waitFor(assertion: () => void, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() - start > timeoutMs) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('resolveUrl', () => {
  it('normalizes host-relative routes and preserves absolute URLs', async () => {
    const { api } = await importApi();

    expect(api.resolveUrl('/health')).toBe('http://127.0.0.1:3017/health');
    expect(api.resolveUrl('api/tools')).toBe('http://127.0.0.1:3017/api/tools');
    expect(api.resolveUrl('https://example.test/x')).toBe('https://example.test/x');
  });
});

describe('JSON requests', () => {
  it('injects the Bearer token on GET requests after host readiness', async () => {
    const { api, calls } = await importApi();
    api.setAuthToken(' token-123 ');

    const result = await api.getJson<{ ok: boolean }>('/api/selfcheck');

    expect(result).toEqual({ ok: true });
    const request = calls.find((call) => call.url.endsWith('/api/selfcheck'));
    expect(request?.init?.headers).toMatchObject({ authorization: 'Bearer token-123' });
  });

  it('shapes POST requests with JSON, idempotency key, and Authorization headers', async () => {
    const { api, calls } = await importApi();
    api.setAuthToken('token-abc');

    await api.postJson('/api/tools/call', {
      idempotencyKey: 'idem-1',
      name: 'Read',
      args: { path: 'README.md' },
    });

    const request = calls.find((call) => call.url.endsWith('/api/tools/call'));
    expect(request?.init?.method).toBe('POST');
    expect(request?.init?.headers).toMatchObject({
      authorization: 'Bearer token-abc',
      'content-type': 'application/json',
      'idempotency-key': 'idem-1',
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      idempotencyKey: 'idem-1',
      name: 'Read',
      args: { path: 'README.md' },
    });
  });

  it('surfaces host JSON errors with the HTTP status attached', async () => {
    const { api } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      return jsonResponse({ error: 'denied' }, 403);
    });

    await expect(api.getJson('/api/workspace')).rejects.toMatchObject({
      message: 'denied',
      status: 403,
    });
  });

  it('posts prompt refinement requests with visible context', async () => {
    const { api, calls } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.endsWith('/api/prompt/refine')) {
        return jsonResponse({
          refined: '更明确的提示',
          changed: true,
          intent: 'review',
          missing: [],
        });
      }
      return jsonResponse({ ok: true });
    });
    api.setAuthToken('prompt-token');

    const result = await api.refinePrompt('看看这个', {
      trustedRoot: 'C:/work',
      context: { project: 'Agent Cowork' },
    });

    const request = calls.find((call) => call.url.endsWith('/api/prompt/refine'));
    expect(request?.init?.method).toBe('POST');
    expect(request?.init?.headers).toMatchObject({
      authorization: 'Bearer prompt-token',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      prompt: '看看这个',
      trustedRoot: 'C:/work',
      context: { project: 'Agent Cowork' },
    });
    expect(result).toEqual({
      refined: '更明确的提示',
      changed: true,
      intent: 'review',
      missing: [],
    });
  });

  it('posts workspace search requests and keeps source line references', async () => {
    const { api, calls } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.endsWith('/api/workspace/search')) {
        return jsonResponse({
          query: 'rag',
          root: 'C:/work',
          indexedFiles: 1,
          chunks: [{ id: 'c1', sourcePath: 'C:/work/a.md', startLine: 3, endLine: 4, text: 'rag source' }],
          sources: [{ path: 'C:/work/a.md', relativePath: 'a.md', startLine: 3, endLine: 4, excerpt: 'rag source' }],
        });
      }
      return jsonResponse({ ok: true });
    });

    const result = await api.searchWorkspace('rag', { trustedRoot: 'C:/work', limit: 5 });

    const request = calls.find((call) => call.url.endsWith('/api/workspace/search'));
    expect(request?.init?.method).toBe('POST');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      query: 'rag',
      trustedRoot: 'C:/work',
      limit: 5,
    });
    expect(result.sources[0]).toMatchObject({ relativePath: 'a.md', startLine: 3, endLine: 4 });
  });

  it('reads, learns, and forgets local memory profile entries', async () => {
    const { api, calls } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.includes('/api/memory/profile?')) {
        return jsonResponse({
          trustedRoot: 'C:/work',
          profile: { version: 1, entries: [] },
          recall: { project: '', terms: [], entries: [] },
        });
      }
      if (url.endsWith('/api/memory/profile/learn')) {
        return jsonResponse({
          trustedRoot: 'C:/work',
          profile: { version: 1, entries: [{ type: 'term', key: 'FE', value: '前端体验', evidence: '用户确认' }] },
          recall: { project: '', terms: ['FE = 前端体验'], entries: [] },
        });
      }
      if (url.endsWith('/api/memory/profile/forget')) {
        return jsonResponse({ removed: 1, profile: { version: 1, entries: [] } });
      }
      return jsonResponse({ ok: true });
    });

    await api.getMemoryProfile('C:/work', 'FE');
    await api.learnMemoryProfile({ type: 'term', key: 'FE', value: '前端体验', evidence: '用户确认' }, 'C:/work');
    const forgotten = await api.forgetMemoryProfile({ type: 'term', key: 'FE' }, 'C:/work');

    expect(calls.find((call) => call.url.includes('/api/memory/profile?'))?.url).toContain('query=FE');
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/api/memory/profile/learn'))?.init?.body))).toEqual({
      type: 'term',
      key: 'FE',
      value: '前端体验',
      evidence: '用户确认',
      trustedRoot: 'C:/work',
    });
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/api/memory/profile/forget'))?.init?.body))).toEqual({
      type: 'term',
      key: 'FE',
      trustedRoot: 'C:/work',
    });
    expect(forgotten.removed).toBe(1);
  });

  it('posts OAuth connector device-flow requests without putting tokens in the client payload', async () => {
    const { api, calls } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.endsWith('/api/connectors/oauth/start')) {
        return jsonResponse({
          provider: 'github',
          sessionId: 'session-1',
          userCode: 'ABCD-1234',
          verificationUri: 'https://github.com/login/device',
          interval: 5,
          scopes: ['read:user'],
        });
      }
      if (url.endsWith('/api/connectors/oauth/complete')) {
        return jsonResponse({ provider: 'github', connected: true, account: { login: 'octocat' } });
      }
      if (url.includes('/api/connectors/oauth/status')) {
        return jsonResponse({ provider: 'github', connected: true, accounts: [{ accountId: 'octocat' }] });
      }
      if (url.endsWith('/api/connectors/oauth/revoke')) {
        return jsonResponse({ provider: 'github', removed: 1 });
      }
      return jsonResponse({ ok: true });
    });

    const started = await api.startOAuthConnector({ id: 'github', scopes: ['read:user'] });
    const completed = await api.completeOAuthConnector({ id: 'github', sessionId: started.sessionId });
    const status = await api.getOAuthConnectorStatus('github');
    const revoked = await api.revokeOAuthConnector({ id: 'github' });

    expect(started.userCode).toBe('ABCD-1234');
    expect(completed.account?.login).toBe('octocat');
    expect(status.connected).toBe(true);
    expect(revoked.removed).toBe(1);
    expect(JSON.stringify(calls)).not.toContain('access_token');
    expect(JSON.parse(String(calls.find((call) => call.url.endsWith('/api/connectors/oauth/start'))?.init?.body))).toEqual({
      id: 'github',
      scopes: ['read:user'],
      idempotencyKey: expect.stringMatching(/^conn-/),
    });
  });
});

describe('host readiness', () => {
  it('returns false when health never becomes ready within the attempt budget', async () => {
    const { api } = await importApi();
    const fetchMock = vi.mocked(globalThis.fetch);
    fetchMock.mockResolvedValue(jsonResponse({ ok: false }, 503));

    await expect(api.ensureHost(2, 0)).resolves.toBe(false);
  });
});

describe('SSE streams', () => {
  it('subscribes to run events with auth headers and parses allowed frames', async () => {
    const { api, calls } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.includes('/api/runs/')) {
        return sseResponse([
          'event: progress',
          'data: {"text":"分析中","icon":"running"}',
          '',
          'event: todo_update',
          'data: {"id":"tool-1","text":"调用 Read","status":"running"}',
          '',
          'event: ignored',
          'data: {"text":"skip"}',
          '',
          'event: assistant_end',
          'data: {"text":"完成"}',
          '',
        ].join('\n'));
      }
      return jsonResponse({ ok: true });
    });
    api.setAuthToken('sse-token');
    const events: unknown[] = [];

    const unsubscribe = api.subscribeRunEvents('run 1', (event) => events.push(event));

    await waitFor(() => expect(events).toHaveLength(3));
    unsubscribe();
    const request = calls.find((call) => call.url.includes('/api/runs/run%201/events'));
    expect(request?.init?.headers).toMatchObject({
      accept: 'text/event-stream',
      authorization: 'Bearer sse-token',
    });
    expect(events).toEqual([
      { type: 'progress', text: '分析中', icon: 'running' },
      { type: 'todo_update', id: 'tool-1', text: '调用 Read', status: 'running' },
      { type: 'assistant_end', text: '完成' },
    ]);
  });

  it('streams chat tokens, reasoning, and done frames from a POST body', async () => {
    const { api, calls } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.endsWith('/api/kimi/chat/stream')) {
        return sseResponse([
          'event: reasoning',
          'data: {"delta":"想一下"}',
          '',
          'event: token',
          'data: {"delta":"你"}',
          '',
          'event: token',
          'data: {"delta":"好"}',
          '',
          'event: done',
          'data: {"text":"你好","runId":"run_1","model":"moonshot"}',
          '',
        ].join('\n'));
      }
      return jsonResponse({ ok: true });
    });
    const reasoning: string[] = [];
    const tokens: string[] = [];
    let done: { text: string; runId?: string; model?: string } | null = null;

    await api.chatStream('打个招呼', { trustedRoot: 'C:/work', model: 'moonshot' }, {
      onReasoning: (delta) => reasoning.push(delta),
      onToken: (delta) => tokens.push(delta),
      onDone: (full) => { done = full; },
    });

    const request = calls.find((call) => call.url.endsWith('/api/kimi/chat/stream'));
    expect(request?.init?.method).toBe('POST');
    expect(JSON.parse(String(request?.init?.body))).toEqual({
      prompt: '打个招呼',
      trustedRoot: 'C:/work',
      model: 'moonshot',
    });
    expect(reasoning).toEqual(['想一下']);
    expect(tokens).toEqual(['你', '好']);
    expect(done).toEqual({ text: '你好', runId: 'run_1', model: 'moonshot' });
  });

  it('streams agent todo snapshots and updates', async () => {
    const { api } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.endsWith('/api/agent/chat/stream')) {
        return sseResponse([
          'event: start',
          'data: {"runId":"run_2"}',
          '',
          'event: todo_snapshot',
          'data: {"todos":[{"id":"plan-1","text":"读取现状","status":"pending"}]}',
          '',
          'event: todo_update',
          'data: {"id":"plan-1","text":"读取现状","status":"done"}',
          '',
          'event: done',
          'data: {"text":"完成","runId":"run_2","usage":{"total_tokens":12}}',
          '',
        ].join('\n'));
      }
      return jsonResponse({ ok: true });
    });
    const snapshots: unknown[] = [];
    const updates: unknown[] = [];
    let done: unknown = null;

    await api.agentChatStream('执行计划', { trustedRoot: 'C:/work', autoApprove: true, planMode: true }, {
      onTodoSnapshot: (todos) => snapshots.push(todos),
      onTodoUpdate: (todo) => updates.push(todo),
      onDone: (full) => { done = full; },
    });

    expect(snapshots).toEqual([[{ id: 'plan-1', text: '读取现状', status: 'pending' }]]);
    expect(updates).toEqual([{ id: 'plan-1', text: '读取现状', status: 'done' }]);
    expect(done).toEqual({ text: '完成', runId: 'run_2', usage: { total_tokens: 12 } });
  });

  it('reports stream JSON errors without throwing to the caller', async () => {
    const { api } = await importApi((url) => {
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      return jsonResponse({ error: 'stream denied' }, 401);
    });
    const errors: string[] = [];

    await expect(api.chatStream('hi', {}, { onError: (message) => errors.push(message) })).resolves.toBeUndefined();

    expect(errors).toEqual(['stream denied']);
  });
});
