import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  Reflect.deleteProperty(globalThis, 'localStorage');
});

it('persists only the selected grant id and sends it with host requests', async () => {
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    },
  });
  stored.set('kcw.recentWorkspaces', JSON.stringify(['C:\\private\\workspace']));
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    calls.push({ url, init });
    return new Response(JSON.stringify(url.endsWith('/api/folder-grants')
      ? { grants: [] }
      : { ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
  }));

  const api = await import('./index') as unknown as {
    getJson<T>(route: string): Promise<T>;
    listFolderGrants(): Promise<{ grants: unknown[] }>;
    setWorkspaceGrantId(id: string | null): void;
  };
  api.setWorkspaceGrantId('grant_selected-1');
  await api.listFolderGrants();
  await api.getJson('/api/projects');

  expect(stored.get('kcw.workspaceGrantId')).toBe('grant_selected-1');
  expect(stored.has('kcw.recentWorkspaces')).toBe(false);
  expect(JSON.stringify([...stored.entries()])).not.toContain('C:\\private\\workspace');
  const projectRequest = calls.find((call) => call.url.endsWith('/api/projects'));
  expect(projectRequest?.init?.headers).toMatchObject({
    'x-workspace-grant-id': 'grant_selected-1',
  });
});
