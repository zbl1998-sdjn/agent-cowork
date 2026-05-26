import childProcess from 'node:child_process';

// Stdio transport for an MCP server child process.
//
// MCP-over-stdio frames each JSON-RPC message as a single line of UTF-8 JSON
// terminated by '\n'. This transport spawns the server, writes outbound
// messages to its stdin, and parses inbound lines from its stdout, handing each
// parsed object to the registered message handler. `spawn` is injectable so the
// whole MCP stack is unit-testable with a fake child.

/**
 * @typedef {import('node:child_process').ChildProcessLike} ChildProcessLike
 * @typedef {(command: string, args?: readonly string[], options?: Record<string, unknown>) => ChildProcessLike} SpawnFn
 * @typedef {(message: import('./json-rpc.js').JsonRpcMessage) => void} MessageHandler
 * @typedef {(event: { code: number | null, signal: string | null }) => void} CloseHandler
 * @typedef {{ command?: string, args?: string[], env?: Record<string, string | undefined>, cwd?: string, spawn?: SpawnFn }} StdioTransportOptions
 */

export class StdioTransport {
  /**
   * @param {StdioTransportOptions} [options]
   */
  constructor({ command, args = [], env = {}, cwd, spawn = childProcess.spawn } = {}) {
    if (!command) {
      throw new Error('StdioTransport: command is required');
    }
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this._spawn = spawn;
    /** @type {ChildProcessLike | null} */
    this._child = null;
    this._buffer = '';
    /** @type {MessageHandler | null} */
    this._messageHandler = null;
    /** @type {Set<CloseHandler>} */
    this._closeHandlers = new Set();
  }

  /**
   * @param {MessageHandler} handler
   */
  onMessage(handler) {
    this._messageHandler = handler;
  }

  /**
   * @param {CloseHandler} handler
   */
  onClose(handler) {
    this._closeHandlers.add(handler);
    return () => this._closeHandlers.delete(handler);
  }

  start() {
    if (this._child) {
      return this;
    }
    const child = this._spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });
    this._child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._ingest(String(chunk)));
    child.on('close', (code, signal) => {
      this._child = null;
      for (const handler of this._closeHandlers) {
        try {
          handler({ code, signal });
        } catch {
          // ignore
        }
      }
    });
    return this;
  }

  /**
   * @param {string} chunk
   */
  _ingest(chunk) {
    this._buffer += chunk;
    let index = this._buffer.indexOf('\n');
    while (index >= 0) {
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (line) {
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = null;
        }
        if (parsed && this._messageHandler) {
          this._messageHandler(parsed);
        }
      }
      index = this._buffer.indexOf('\n');
    }
  }

  /**
   * @param {unknown} message
   */
  send(message) {
    if (!this._child || !this._child.stdin) {
      throw new Error('StdioTransport: not started');
    }
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close() {
    if (this._child) {
      try {
        this._child.kill('SIGTERM');
      } catch {
        // ignore
      }
      this._child = null;
    }
  }
}
