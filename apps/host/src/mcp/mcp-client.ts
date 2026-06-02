// MCP 客户端(host · L1 领域层 · mcp)
// ---------------------------------------------------------------------------
// 职责:基于注入式 transport 的小型 MCP 客户端。生命周期:connect()→initialize 握手→
//       listTools()/callTool()→close()。transport 只需实现 start/send/onMessage/onClose/close,
//       默认用 StdioTransport,测试可注入假实现。依赖:同层 json-rpc。导出:McpClient。
import { JsonRpcClient, type JsonRpcMessage } from './json-rpc.js';

// A small MCP (Model Context Protocol) client over an injected transport.
//
// Lifecycle: connect() -> initialize handshake -> listTools()/callTool() -> close().
// The transport only needs { start(), send(obj), onMessage(cb), onClose(cb),
// close() }; StdioTransport is the default real one, but tests inject a fake.

const PROTOCOL_VERSION = '2024-11-05';

export type McpTransport = {
  start?: () => void;
  send(message: unknown): void;
  onMessage(handler: (message: JsonRpcMessage) => void): void;
  onClose?: (handler: () => void) => unknown;
  close?: () => void;
};
export type McpClientInfo = { name: string; version: string };
export type McpClientOptions = { transport?: McpTransport; clientInfo?: McpClientInfo; timeoutMs?: number };

/** MCP 客户端:对接单个 MCP 服务器,负责握手、列工具、调用工具与关闭。 */
export class McpClient {
  readonly transport: McpTransport;
  readonly clientInfo: McpClientInfo;
  connected: boolean;
  serverInfo: unknown | null;
  capabilities: unknown | null;
  private readonly _rpc: JsonRpcClient;

  constructor({ transport, clientInfo = { name: 'agent-cowork-host', version: '0.1.0' }, timeoutMs = 15_000 }: McpClientOptions = {}) {
    if (!transport) {
      throw new Error('McpClient: transport is required');
    }
    this.transport = transport;
    this.clientInfo = clientInfo;
    this.connected = false;
    this.serverInfo = null;
    this.capabilities = null;
    this._rpc = new JsonRpcClient({
      send: (message) => this.transport.send(message),
      timeoutMs,
    });
    this.transport.onMessage((message) => this._rpc.handleMessage(message));
    if (typeof this.transport.onClose === 'function') {
      this.transport.onClose(() => {
        this.connected = false;
        this._rpc.rejectAll(new Error('MCP transport closed'));
      });
    }
  }

  async connect(): Promise<unknown> {
    if (this.connected) {
      return this.serverInfo;
    }
    if (typeof this.transport.start === 'function') {
      this.transport.start();
    }
    const result = await this._rpc.request('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      clientInfo: this.clientInfo,
    });
    const response = result && typeof result === 'object' ? (result as { serverInfo?: unknown; capabilities?: unknown }) : {};
    this.serverInfo = response.serverInfo || null;
    this.capabilities = response.capabilities || null;
    this._rpc.notify('notifications/initialized');
    this.connected = true;
    return this.serverInfo;
  }

  async listTools(): Promise<unknown[]> {
    const result = await this._rpc.request('tools/list', {});
    const response = result && typeof result === 'object' ? (result as { tools?: unknown }) : {};
    return Array.isArray(response.tools) ? response.tools : [];
  }

  async callTool(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!name) {
      throw new Error('McpClient.callTool: name is required');
    }
    return this._rpc.request('tools/call', { name, arguments: args });
  }

  close(): void {
    this.connected = false;
    this._rpc.rejectAll(new Error('MCP client closed'));
    if (typeof this.transport.close === 'function') {
      this.transport.close();
    }
  }
}
