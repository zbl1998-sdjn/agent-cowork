// JSON-RPC 2.0 客户端内核(host · L1 领域层 · mcp,与传输无关)
// ---------------------------------------------------------------------------
// 职责:持有请求 id 计数器与待决请求表,但不关心字节如何传输——调用方注入 send(message),并把入站
//       消息喂回 handleMessage(message)。协议逻辑因此保持纯净、无需真实 MCP 服务器即可单测。
// 依赖:无。导出:JsonRpcError / JsonRpcClient。
// Minimal JSON-RPC 2.0 client core (transport-agnostic).
//
// The client owns the request-id counter and the pending-request map. It does
// NOT know how bytes move: callers inject a `send(message)` function (a stdio
// pipe, a WebSocket, an in-memory stub in tests) and feed inbound messages back
// via `handleMessage(message)`. That keeps the protocol logic pure and unit
// testable without spawning a real MCP server.

export type JsonRpcWireError = { message?: string; code?: unknown; data?: unknown };
export type JsonRpcMessage = {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcWireError;
};
export type JsonRpcSend = (message: JsonRpcMessage) => void;
export type NotificationHandler = (method: string, params?: unknown) => void;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
export type JsonRpcClientOptions = { send?: JsonRpcSend; timeoutMs?: number };

export class JsonRpcError extends Error {
  code: unknown;
  data: unknown;

  constructor(message: string, code?: unknown, data?: unknown) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export class JsonRpcClient {
  private readonly _send: JsonRpcSend;
  private readonly _timeoutMs: number;
  private _nextId: number;
  private readonly _pending: Map<number, PendingRequest>;
  private readonly _notificationHandlers: Set<NotificationHandler>;

  constructor({ send, timeoutMs = 15_000 }: JsonRpcClientOptions = {}) {
    if (typeof send !== 'function') {
      throw new Error('JsonRpcClient: send(message) is required');
    }
    this._send = send;
    this._timeoutMs = timeoutMs;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._notificationHandlers = new Set();
  }

  onNotification(handler: NotificationHandler): () => boolean {
    this._notificationHandlers.add(handler);
    return () => this._notificationHandlers.delete(handler);
  }

  request(method: string, params?: unknown, { timeoutMs }: { timeoutMs?: number } = {}): Promise<unknown> {
    const id = this._nextId++;
    const message: JsonRpcMessage = { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      message.params = params;
    }
    return new Promise((resolve, reject) => {
      const budget = timeoutMs == null ? this._timeoutMs : timeoutMs;
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new JsonRpcError(`JSON-RPC request "${method}" timed out after ${budget}ms`, 'ETIMEDOUT'));
      }, budget);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this._send(message);
      } catch (err) {
        this._settleError(id, err);
      }
    });
  }

  notify(method: string, params?: unknown): void {
    const message: JsonRpcMessage = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      message.params = params;
    }
    this._send(message);
  }

  handleMessage(message: unknown): void {
    if (!message || typeof message !== 'object') {
      return;
    }
    const rpcMessage = message as JsonRpcMessage;
    // A response carries an id we issued.
    if (Object.prototype.hasOwnProperty.call(rpcMessage, 'id') && typeof rpcMessage.id === 'number' && this._pending.has(rpcMessage.id)) {
      const entry = this._pending.get(rpcMessage.id);
      if (!entry) {
        return;
      }
      this._pending.delete(rpcMessage.id);
      clearTimeout(entry.timer);
      if (rpcMessage.error) {
        entry.reject(new JsonRpcError(rpcMessage.error.message || 'JSON-RPC error', rpcMessage.error.code, rpcMessage.error.data));
      } else {
        entry.resolve(rpcMessage.result);
      }
      return;
    }
    // Otherwise it is a server-initiated notification (no matching id).
    if (rpcMessage.method) {
      for (const handler of this._notificationHandlers) {
        try {
          handler(rpcMessage.method, rpcMessage.params);
        } catch {
          // a misbehaving handler must not break the dispatch loop
        }
      }
    }
  }

  private _settleError(id: number, err: unknown): void {
    const entry = this._pending.get(id);
    if (!entry) {
      return;
    }
    this._pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(err);
  }

  rejectAll(reason: unknown): void {
    const err = reason instanceof Error ? reason : new Error(String(reason || 'closed'));
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this._pending.delete(id);
    }
  }
}
