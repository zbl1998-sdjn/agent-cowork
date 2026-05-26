// Minimal JSON-RPC 2.0 client core (transport-agnostic).
//
// The client owns the request-id counter and the pending-request map. It does
// NOT know how bytes move: callers inject a `send(message)` function (a stdio
// pipe, a WebSocket, an in-memory stub in tests) and feed inbound messages back
// via `handleMessage(message)`. That keeps the protocol logic pure and unit
// testable without spawning a real MCP server.

/**
 * @typedef {{ message?: string, code?: unknown, data?: unknown }} JsonRpcWireError
 * @typedef {{ jsonrpc?: string, id?: string | number | null, method?: string, params?: unknown, result?: unknown, error?: JsonRpcWireError }} JsonRpcMessage
 * @typedef {(message: JsonRpcMessage) => void} JsonRpcSend
 * @typedef {(method: string, params?: unknown) => void} NotificationHandler
 * @typedef {{ resolve: (value: unknown) => void, reject: (reason?: unknown) => void, timer: ReturnType<typeof setTimeout> }} PendingRequest
 * @typedef {{ send?: JsonRpcSend, timeoutMs?: number, now?: () => number }} JsonRpcClientOptions
 */

export class JsonRpcError extends Error {
  /**
   * @param {string} message
   * @param {unknown} [code]
   * @param {unknown} [data]
   */
  constructor(message, code, data) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
    this.data = data;
  }
}

export class JsonRpcClient {
  /**
   * @param {JsonRpcClientOptions} [options]
   */
  constructor({ send, timeoutMs = 15_000, now = Date.now } = {}) {
    if (typeof send !== 'function') {
      throw new Error('JsonRpcClient: send(message) is required');
    }
    /** @type {JsonRpcSend} */
    this._send = send;
    this._timeoutMs = timeoutMs;
    this._now = now;
    this._nextId = 1;
    /** @type {Map<number, PendingRequest>} */
    this._pending = new Map(); // id -> { resolve, reject, timer }
    /** @type {Set<NotificationHandler>} */
    this._notificationHandlers = new Set();
  }

  /**
   * @param {NotificationHandler} handler
   */
  onNotification(handler) {
    this._notificationHandlers.add(handler);
    return () => this._notificationHandlers.delete(handler);
  }

  /**
   * @param {string} method
   * @param {unknown} [params]
   * @param {{ timeoutMs?: number }} [options]
   * @returns {Promise<unknown>}
   */
  request(method, params, { timeoutMs } = {}) {
    const id = this._nextId++;
    const message = /** @type {JsonRpcMessage} */ ({ jsonrpc: '2.0', id, method });
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

  /**
   * @param {string} method
   * @param {unknown} [params]
   */
  notify(method, params) {
    const message = /** @type {JsonRpcMessage} */ ({ jsonrpc: '2.0', method });
    if (params !== undefined) {
      message.params = params;
    }
    this._send(message);
  }

  /**
   * @param {JsonRpcMessage} message
   */
  handleMessage(message) {
    if (!message || typeof message !== 'object') {
      return;
    }
    // A response carries an id we issued.
    if (Object.prototype.hasOwnProperty.call(message, 'id') && typeof message.id === 'number' && this._pending.has(message.id)) {
      const entry = this._pending.get(message.id);
      if (!entry) {
        return;
      }
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

  /**
   * @param {number} id
   * @param {unknown} err
   */
  _settleError(id, err) {
    const entry = this._pending.get(id);
    if (!entry) {
      return;
    }
    this._pending.delete(id);
    clearTimeout(entry.timer);
    entry.reject(err);
  }

  /**
   * @param {unknown} reason
   */
  rejectAll(reason) {
    const err = reason instanceof Error ? reason : new Error(String(reason || 'closed'));
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
      this._pending.delete(id);
    }
  }
}
