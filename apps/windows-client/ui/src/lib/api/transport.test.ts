import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => undefined) }));

// Keep the module-load host probe fast and quiet so importing transport.ts
// doesn't spin the ensureHost() retry loop.
vi.stubGlobal(
  'fetch',
  vi.fn(async () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } })),
);

type Loc = { origin: string; port: string; protocol: string; hostname: string };
const hadWindow = 'window' in globalThis;
const originalWindow = (globalThis as unknown as { window?: unknown }).window;

function setLocation(loc: Loc): void {
  (globalThis as unknown as { window: unknown }).window = { location: loc };
}

afterEach(() => {
  if (hadWindow) (globalThis as unknown as { window: unknown }).window = originalWindow;
  else delete (globalThis as unknown as { window?: unknown }).window;
});

describe('defaultHostBase (host base URL selection)', () => {
  it('REGRESSION: falls back to the loopback host from the packaged tauri.localhost webview', async () => {
    // Real bug: window.location.origin is http://tauri.localhost in the packaged
    // build; returning it sent /api calls to the asset protocol → index.html →
    // "Unexpected token '<' ... is not valid JSON".
    setLocation({ origin: 'http://tauri.localhost', port: '', protocol: 'http:', hostname: 'tauri.localhost' });
    const { defaultHostBase } = await import('./transport');
    expect(defaultHostBase()).toBe('http://127.0.0.1:3017');
  });

  it('falls back to the loopback host for the tauri: custom protocol', async () => {
    setLocation({ origin: 'tauri://localhost', port: '', protocol: 'tauri:', hostname: 'localhost' });
    const { defaultHostBase } = await import('./transport');
    expect(defaultHostBase()).toBe('http://127.0.0.1:3017');
  });

  it('falls back to the loopback host under Vite dev (:5173)', async () => {
    setLocation({ origin: 'http://127.0.0.1:5173', port: '5173', protocol: 'http:', hostname: '127.0.0.1' });
    const { defaultHostBase } = await import('./transport');
    expect(defaultHostBase()).toBe('http://127.0.0.1:3017');
  });

  it('trusts the page origin when the host itself served the page over http', async () => {
    setLocation({ origin: 'http://127.0.0.1:3017', port: '3017', protocol: 'http:', hostname: '127.0.0.1' });
    const { defaultHostBase } = await import('./transport');
    expect(defaultHostBase()).toBe('http://127.0.0.1:3017');
  });
});
