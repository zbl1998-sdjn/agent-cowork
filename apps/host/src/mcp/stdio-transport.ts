// MCP stdio 传输(host · L1 领域层 · mcp)
// ---------------------------------------------------------------------------
// 职责:MCP-over-stdio 传输层。每条 JSON-RPC 消息以「单行 UTF-8 JSON + \n」成帧:拉起服务器子进程,
//       把出站消息写入其 stdin,从 stdout 逐行解析入站消息回调给上层。spawn 可注入便于单测。
// 依赖:node:child_process。导出:StdioTransport。
import childProcess from 'node:child_process';
import type { ChildProcessLike } from 'node:child_process';
import type { JsonRpcMessage } from './json-rpc.js';

// stdio 传输只负责「行分帧」和子进程管道:写 stdin、读 stdout、逐行 JSON.parse 后交回上层。
// spawn 可注入,让完整 MCP 栈能用 fake child 单测。

type ChildWithPipes = ChildProcessLike & { stdin: NonNullable<ChildProcessLike['stdin']> };
export type SpawnFn = (command: string, args?: readonly string[], options?: Record<string, unknown>) => ChildProcessLike;
export type MessageHandler = (message: JsonRpcMessage) => void;
export type CloseHandler = (event: { code: number | null; signal: string | null }) => void;
export type StdioTransportOptions = {
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  spawn?: SpawnFn;
};

export class StdioTransport {
  readonly command: string;
  readonly args: string[];
  readonly env: Record<string, string | undefined>;
  readonly cwd: string | undefined;
  private readonly _spawn: SpawnFn;
  private _child: ChildWithPipes | null;
  private _buffer: string;
  private _messageHandler: MessageHandler | null;
  private readonly _closeHandlers: Set<CloseHandler>;

  constructor({ command, args = [], env = {}, cwd, spawn = childProcess.spawn }: StdioTransportOptions = {}) {
    if (!command) {
      throw new Error('StdioTransport: command is required');
    }
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this._spawn = spawn;
    this._child = null;
    this._buffer = '';
    this._messageHandler = null;
    this._closeHandlers = new Set();
  }

  onMessage(handler: MessageHandler): void {
    this._messageHandler = handler;
  }

  onClose(handler: CloseHandler): () => boolean {
    this._closeHandlers.add(handler);
    return () => this._closeHandlers.delete(handler);
  }

  start(): this {
    if (this._child) {
      return this;
    }
    const child = this._spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...(process.env.PATH ? { PATH: process.env.PATH } : {}), ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    }) as ChildWithPipes;
    this._child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: Buffer | string) => this._ingest(String(chunk)));
    child.on('close', (code: number | null, signal: string | null) => {
      this._child = null;
      for (const handler of this._closeHandlers) {
        try {
          handler({ code, signal });
        } catch {
          // 关闭回调失败不影响其它回调。
        }
      }
    });
    return this;
  }

  private _ingest(chunk: string): void {
    this._buffer += chunk;
    let index = this._buffer.indexOf('\n');
    while (index >= 0) {
      const line = this._buffer.slice(0, index).trim();
      this._buffer = this._buffer.slice(index + 1);
      if (line) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parsed = null;
        }
        if (parsed && this._messageHandler) {
          this._messageHandler(parsed as JsonRpcMessage);
        }
      }
      index = this._buffer.indexOf('\n');
    }
  }

  send(message: unknown): void {
    if (!this._child || !this._child.stdin) {
      throw new Error('StdioTransport: not started');
    }
    this._child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  close(): void {
    if (this._child) {
      try {
        this._child.kill('SIGTERM');
      } catch {
        // 进程可能已经退出,忽略关闭竞态。
      }
      this._child = null;
    }
  }
}
