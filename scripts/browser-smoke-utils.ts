// 浏览器 smoke 测试共享工具库(scripts · 工具库)
// ---------------------------------------------------------------------------
// 职责:为各 smoke-react-*/smoke-rendered-ui 脚本提供通用底座——查找本机浏览器
//       (Edge/Chrome)、申请空闲端口、把 host server 绑定到 127.0.0.1、轮询 HTTP
//       JSON、以及一个最小 CDP(Chrome DevTools Protocol)WebSocket 客户端,
//       用于在无头浏览器里 evaluate 页面脚本、截图等。
// 用法:不直接运行;被 scripts/smoke-react-*.ts、scripts/smoke-rendered-ui.ts
//       import 复用(findBrowser/getFreePort/bind/getJson/evaluate/CdpClient 等)。
// 依赖:node:http/net/fs、全局 WebSocket、被测的 host server(createServer)。
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import type { Server } from 'node:http';

export type CdpVersion = { webSocketDebuggerUrl: string };
export type CdpTarget = { targetId: string };
export type CdpSession = { sessionId: string };
export type ScreenshotResult = { data: string };
export type SendPage = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

type CdpSuccess<T> = { id?: number; result?: T; method?: undefined; params?: undefined; error?: undefined };
type CdpEvent = { id?: undefined; result?: undefined; method?: string; params?: unknown; error?: undefined };
type CdpFailure = { id?: number; result?: undefined; method?: undefined; params?: undefined; error: { message?: string; data?: string } };
type CdpMessage<T = unknown> = CdpSuccess<T> | CdpEvent | CdpFailure;
type CdpPending = { resolve: (value: unknown) => void; reject: (reason?: unknown) => void };
type CdpHandler = (params: unknown) => void;
type CdpEvaluateResult = {
  exceptionDetails?: { exception?: { description?: string }; text?: string };
  result?: { value?: unknown };
};

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function errorDetails(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : String(error);
}

export function findBrowser(): string | null {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.join(process.env.ProgramFiles || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.join(process.env['ProgramFiles(x86)'] || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      ]
    : ['google-chrome', 'chromium', 'chromium-browser', 'microsoft-edge'];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

export async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('free port probe did not return an address object'));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export async function getJson<T>(url: string, timeoutMs = 5000, headers: Record<string, string> = {}): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return await new Promise((resolve, reject) => {
        const httpGet = http.get as unknown as (
          requestUrl: string,
          options: { headers: Record<string, string> },
          callback: (response: http.IncomingMessage) => void,
        ) => http.ClientRequest;
        const request = httpGet(url, { headers }, (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => { body += String(chunk); });
          response.on('end', () => {
            const statusCode = response.statusCode ?? 0;
            if (statusCode < 200 || statusCode >= 300) {
              reject(new Error(`${url} returned ${response.statusCode}: ${body}`));
              return;
            }
            resolve(JSON.parse(body) as T);
          });
        });
        request.on('error', reject);
        request.setTimeout(1000, () => request.destroy(new Error(`Timed out fetching ${url}`)));
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

export class CdpClient {
  private socket?: WebSocket;
  private nextId = 1;
  private readonly pending = new Map<number, CdpPending>();
  private readonly handlers = new Map<string, CdpHandler[]>();
  private readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  async open(): Promise<void> {
    const socket = new WebSocket(this.url);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out opening DevTools websocket')), 5000);
      socket.addEventListener('open', () => { clearTimeout(timeout); resolve(); }, { once: true });
      socket.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('Failed opening DevTools websocket'));
      }, { once: true });
    });

    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        assert(pending, `missing pending CDP call for id ${message.id}`);
        const { resolve, reject } = pending;
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message}: ${message.error.data || ''}`.trim()));
        else resolve(message.result || {});
        return;
      }
      if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method) || []) handler(message.params || {});
      }
    });
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++;
    assert(this.socket, 'DevTools websocket is not open');
    this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });
    });
  }

  close(): void {
    this.socket?.close();
  }
}

export async function evaluate(sendPage: SendPage, expression: string, awaitPromise = true): Promise<unknown> {
  const result = await sendPage<CdpEvaluateResult>('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Runtime.evaluate failed';
    throw new Error(detail);
  }
  return result.result?.value;
}

export async function bind(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'host server did not bind to a TCP address');
  return `http://127.0.0.1:${address.port}`;
}
