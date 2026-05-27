import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => undefined),
}));

function setStorage(): void {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('project workspace api', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('lists and mutates projects through the host routes with idempotency headers', async () => {
    setStorage();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    (globalThis as unknown as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calls.push({ url, init });
      if (url.endsWith('/health')) return jsonResponse({ ok: true });
      if (url.includes('/api/projects?')) return jsonResponse({ trustedRoot: 'C:/work', projects: [] });
      if (url.endsWith('/api/projects')) {
        return jsonResponse({
          project: { id: 'proj_1', name: '客户 A', archived: false, createdAt: 1, updatedAt: 1, stats: { conversations: 0, artifacts: 0 }, conversations: [], artifacts: [] },
        });
      }
      return jsonResponse({ project: { id: 'proj_1' }, deleted: true });
    }) as unknown as typeof fetch;

    const api = await import('./projects');
    await api.listProjects('C:/work', true);
    await api.createProject('客户 A', '#2563eb', 'C:/work');
    await api.updateProject('proj_1', { archived: true }, 'C:/work');
    await api.deleteProject('proj_1', 'C:/work');

    expect(calls.some((call) => call.url.includes('/api/projects?includeArchived=1'))).toBe(true);
    const create = calls.find((call) => call.url.endsWith('/api/projects') && call.init?.method === 'POST');
    const update = calls.find((call) => call.url.endsWith('/api/projects/proj_1') && call.init?.method === 'PATCH');
    const del = calls.find((call) => call.url.endsWith('/api/projects/proj_1') && call.init?.method === 'DELETE');
    expect(create?.init?.headers).toMatchObject({ 'idempotency-key': expect.stringMatching(/^project-create-/) });
    expect(update?.init?.headers).toMatchObject({ 'idempotency-key': expect.stringMatching(/^project-update-/) });
    expect(del?.init?.headers).toMatchObject({ 'idempotency-key': expect.stringMatching(/^project-delete-/) });
  });
});
