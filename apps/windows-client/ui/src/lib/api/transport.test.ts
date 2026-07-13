import { invoke } from '@tauri-apps/api/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

// 导入 transport.ts 会在模块加载期启动 host 探测;这里把 fetch 固定为成功,
// 避免单测进入 ensureHost 的重试等待。
vi.stubGlobal(
  'fetch',
  vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })),
);

type Loc = { origin: string; port: string; protocol: string; hostname: string };
const hadWindow = 'window' in globalThis;
const originalWindow = (globalThis as unknown as { window?: unknown }).window;

// 每个用例显式替换 window.location,用真实 origin/port/protocol 组合复现不同运行态。
function setLocation(loc: Loc): void {
  (globalThis as unknown as { window: unknown }).window = { location: loc };
}

function setDesktopLocation(loc: Loc): void {
  (globalThis as unknown as { window: unknown }).window = { location: loc, __TAURI_INTERNALS__: {} };
}

// 还原全局 window,防止一个 origin 场景污染后续 host base 判断。
afterEach(() => {
  vi.useRealTimers();
  vi.mocked(invoke).mockReset();
  vi.mocked(fetch).mockClear();
  if (hadWindow) (globalThis as unknown as { window: unknown }).window = originalWindow;
  else delete (globalThis as unknown as { window?: unknown }).window;
});

describe('defaultHostBase (host base URL selection)', () => {
  it('REGRESSION: falls back to the loopback host from the packaged tauri.localhost webview', async () => {
    // 真实回归:安装版里 window.location.origin 是 http://tauri.localhost;
    // 若把它当 host, /api 会打到资源协议并拿到 index.html,随后 JSON 解析报错。
    setLocation({ origin: 'http://tauri.localhost', port: '', protocol: 'http:', hostname: 'tauri.localhost' });
    const { defaultHostBase } = await import('./transport');
    expect(defaultHostBase()).toBe('http://127.0.0.1:3017');
  });

  it('falls back to the loopback host for the tauri: custom protocol', async () => {
    // 自定义 tauri: 协议永远不是 host HTTP origin,必须回落到本地 sidecar。
    setLocation({ origin: 'tauri://localhost', port: '', protocol: 'tauri:', hostname: 'localhost' });
    const { defaultHostBase } = await import('./transport');
    expect(defaultHostBase()).toBe('http://127.0.0.1:3017');
  });

  it('falls back to the loopback host under Vite dev (:5173)', async () => {
    // Vite dev server 只负责前端资源,API 仍由 3017 host 提供。
    setLocation({ origin: 'http://127.0.0.1:5173', port: '5173', protocol: 'http:', hostname: '127.0.0.1' });
    const { defaultHostBase } = await import('./transport');
    expect(defaultHostBase()).toBe('http://127.0.0.1:3017');
  });

  it('trusts the page origin when the host itself served the page over http', async () => {
    // 如果页面本身由 host 提供,同源请求应继续命中当前 origin。
    setLocation({ origin: 'http://127.0.0.1:3017', port: '3017', protocol: 'http:', hostname: '127.0.0.1' });
    const { defaultHostBase } = await import('./transport');
    expect(defaultHostBase()).toBe('http://127.0.0.1:3017');
  });
});

describe('desktop sidecar identity gate', () => {
  const desktopLocation: Loc = {
    origin: 'http://tauri.localhost',
    port: '',
    protocol: 'http:',
    hostname: 'tauri.localhost',
  };
  const verifiedStatus = { url: 'http://127.0.0.1:3017', running: true, verified: true };
  const unverifiedStatus = { ...verifiedStatus, verified: false };

  it('does not trust a public /health 200 when native status is unverified', async () => {
    vi.useFakeTimers();
    setDesktopLocation(desktopLocation);
    vi.mocked(invoke).mockResolvedValue(unverifiedStatus);
    vi.mocked(fetch).mockClear();
    const { ensureHost } = await import('./transport');
    const pending = ensureHost(1, 0);
    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts a desktop host only after native verification', async () => {
    setDesktopLocation(desktopLocation);
    vi.mocked(invoke).mockResolvedValue(verifiedStatus);
    vi.mocked(fetch).mockClear();
    const { ensureHost } = await import('./transport');
    await expect(ensureHost(1, 0)).resolves.toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks an API fetch after the native verified state is revoked', async () => {
    vi.useFakeTimers();
    setDesktopLocation(desktopLocation);
    vi.mocked(invoke).mockResolvedValue(unverifiedStatus);
    vi.mocked(fetch).mockClear();
    const { getJson } = await import('./transport');
    const pending = getJson('/api/workspace');
    const rejected = expect(pending).rejects.toThrow('desktop host identity is not verified');
    await vi.runAllTimersAsync();
    await rejected;
    expect(fetch).not.toHaveBeenCalled();
  });
});
