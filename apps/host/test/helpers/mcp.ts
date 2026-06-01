import assert from 'node:assert/strict';
import type { ChildProcessLike } from 'node:child_process';
import { z } from 'zod';
import type { JsonRpcMessage, JsonRpcWireError } from '../../src/mcp/json-rpc.js';
import type { McpTransport } from '../../src/mcp/mcp-client.js';
import type { SpawnFn } from '../../src/mcp/stdio-transport.js';

const jsonRpcMessageSchema = z.object({
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string().optional(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.object({
    message: z.string().optional(),
    code: z.unknown().optional(),
    data: z.unknown().optional(),
  }).passthrough().optional(),
}).passthrough();

export const serverInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
}).passthrough();

export const mcpToolSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
}).passthrough();

export const toolCallResultSchema = z.object({
  content: z.array(z.object({
    type: z.string(),
    text: z.string(),
  }).passthrough()),
}).passthrough();

const toolCallParamsSchema = z.object({
  name: z.string(),
}).passthrough();

type Listener = (...args: unknown[]) => void;
class SimpleEmitter {
  private readonly listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): this {
    const current = this.listeners.get(event) ?? [];
    current.push(listener);
    this.listeners.set(event, current);
    return this;
  }

  emit(event: string, ...args: unknown[]): boolean {
    const current = this.listeners.get(event) ?? [];
    for (const listener of current) {
      listener(...args);
    }
    return current.length > 0;
  }
}

type FakeStdout = SimpleEmitter & { setEncoding(encoding: string): void };
type FakeStdin = { writes: string[]; write(chunk: string): boolean };
export type FakeChild = SimpleEmitter & {
  stdin: FakeStdin;
  stdout: FakeStdout;
  stderr: SimpleEmitter;
  killed?: boolean;
  kill(signal?: string | number): void;
};

export type ScriptedTransport = McpTransport & {
  started: boolean;
  sent: JsonRpcMessage[];
  closed?: boolean;
};

export function itemAt<T>(items: readonly T[], index: number, label: string): T {
  const item = items[index];
  assert.ok(item, `${label} should exist`);
  return item;
}

export function parseJsonRpcMessage(value: unknown): JsonRpcMessage {
  const parsed = jsonRpcMessageSchema.parse(value);
  const message: JsonRpcMessage = {};
  if (parsed.jsonrpc !== undefined) message.jsonrpc = parsed.jsonrpc;
  if (parsed.id !== undefined) message.id = parsed.id;
  if (parsed.method !== undefined) message.method = parsed.method;
  if (parsed.params !== undefined) message.params = parsed.params;
  if (parsed.result !== undefined) message.result = parsed.result;
  if (parsed.error !== undefined) {
    const error: JsonRpcWireError = {};
    if (parsed.error.message !== undefined) error.message = parsed.error.message;
    if (parsed.error.code !== undefined) error.code = parsed.error.code;
    if (parsed.error.data !== undefined) error.data = parsed.error.data;
    message.error = error;
  }
  return message;
}

export function createFakeChild(): FakeChild {
  const child = new SimpleEmitter() as FakeChild;
  child.stdin = {
    writes: [],
    write(chunk: string) {
      this.writes.push(chunk);
      return true;
    },
  };
  child.stdout = new SimpleEmitter() as FakeStdout;
  child.stdout.setEncoding = () => undefined;
  child.stderr = new SimpleEmitter();
  child.kill = () => {
    child.killed = true;
  };
  return child;
}

export function spawnFakeChild(child: FakeChild): SpawnFn {
  return () => child as unknown as ChildProcessLike;
}

export function createScriptedTransport(
  responder: (message: JsonRpcMessage) => JsonRpcMessage | undefined,
): ScriptedTransport {
  let handler: ((message: JsonRpcMessage) => void) | null = null;
  return {
    started: false,
    sent: [],
    start() {
      this.started = true;
    },
    onMessage(callback) {
      handler = callback;
    },
    onClose() {
      return undefined;
    },
    send(message) {
      const parsed = parseJsonRpcMessage(message);
      this.sent.push(parsed);
      const reply = responder(parsed);
      if (reply !== undefined) {
        setTimeout(() => {
          if (handler) handler(reply);
        }, 0);
      }
    },
    close() {
      this.closed = true;
    },
  };
}

export function mcpResponder(message: JsonRpcMessage): JsonRpcMessage | undefined {
  if (message.id == null) {
    return undefined;
  }
  if (message.method === 'initialize') {
    return { jsonrpc: '2.0', id: message.id, result: { serverInfo: { name: 'fake-mcp', version: '1.0' }, capabilities: { tools: {} } } };
  }
  if (message.method === 'tools/list') {
    return { jsonrpc: '2.0', id: message.id, result: { tools: [{ name: 'echo', description: 'echo back' }] } };
  }
  if (message.method === 'tools/call') {
    const params = toolCallParamsSchema.parse(message.params);
    return { jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: `called ${params.name}` }] } };
  }
  return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown' } };
}
