import { JsonRpcClient } from './json-rpc.js';

// A small MCP (Model Context Protocol) client over an injected transport.
//
// Lifecycle: connect() -> initialize handshake -> listTools()/callTool() -> close().
// The transport only needs { start(), send(obj), onMessage(cb), onClose(cb),
// close() }; StdioTransport is the default real one, but tests inject a fake.

const PROTOCOL_VERSION = '2024-11-05';

export class McpClient {
  constructor({ transport, clientInfo = { name: 'agent-cowork-host', version: '0.1.0' }, timeoutMs = 15_000 } = {}) {
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

  async connect() {
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
    this.serverInfo = result?.serverInfo || null;
    this.capabilities = result?.capabilities || null;
    this._rpc.notify('notifications/initialized');
    this.connected = true;
    return this.serverInfo;
  }

  async listTools() {
    const result = await this._rpc.request('tools/list', {});
    return Array.isArray(result?.tools) ? result.tools : [];
  }

  async callTool(name, args = {}) {
    if (!name) {
      throw new Error('McpClient.callTool: name is required');
    }
    return this._rpc.request('tools/call', { name, arguments: args });
  }

  close() {
    this.connected = false;
    this._rpc.rejectAll(new Error('MCP client closed'));
    if (typeof this.transport.close === 'function') {
      this.transport.close();
    }
  }
}
