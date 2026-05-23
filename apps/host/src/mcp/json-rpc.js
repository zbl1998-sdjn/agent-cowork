// Minimal JSON-RPC 2.0 client core (transport-agnostic).
//
// The client owns the request-id counter and the pending-request map. It does
// NOT know how bytes move: callers inject a `send(message)` function (a stdio
// pipe, a WebSocket, an in-memory stub in tests) and feed inbound messages back
// via `handleMessage(message)`. That keeps the protocol logic pure and unit
// testable without spawning a real MCP server.

export class JsonRpcError extends Error {
  constructor(message, code, data) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export class JsonRpcClient {
  constructor({ send, timeoutMs = 15_000, now = Date.now } = {}) {
    if (typeof send !== 'function') {
      throw new Error('JsonRpcClient: send(message) is required');
    }
    this._send = send;
    this._timeoutMs = timeoutMs;
    this._now = now;
    this._nextId = 1;
    this._pending = new Map(); // id -> { resolve, reject, timer }
    this._notificationHandlers = new Set();
  }

  onNotification(handler) {
    this._notificationHandlers.add(handler);
    return () => this._notificationHandlers.delete(handler);
  }

  request(method, params, { timeoutMs } = {}) {
    const id = this._nextId++;
    const message = { jsonrpc: '2.0', id, method };
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

  notify(method, params) {
    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) {
      message.params = params;
    }
    this._send(message);
  }

  handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    // A response carries an id we issued.
    if (Object.prototype.hasOwnProperty.call(message, 'id') && message.id != null && this._pending.has(message.id)) {
      const entry = this._pending.get(message.id);
      this._pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) {
        entry.reject(new JsonRpcError(message.error.message || 'JSON-RPC error', message.error.code, message.error.data));
      } else {
        entry.resolve(message.result);
      }
      return;
    }
    // Otherwise it is a server-initiated notification (no matching id).
    if (message.method) {
      for (const handler of this._notificationHandlers) {
        try {
          handler(message.method, message.params);
        } catch {
          // a misbehaving handler must not break the dispatch loop
        }
      }
    }
  }

  _settleError(id, err) {
    const entry = this._pending.get(id);
    if (!entry) {
      return;
    }
    this._pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(err);
  }

  rejectAll(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason || 'closed'));
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this._pending.delete(id);
    }
  }
}
