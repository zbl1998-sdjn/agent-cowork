// MCP 批量接入(host · L1 领域层 · mcp)
// ---------------------------------------------------------------------------
// 职责:按一组 MCP 服务器规格逐个以 stdio 拉起、握手、把其工具以 `mcp__<name>__<tool>` 导入注册表。
//       单个服务器连接失败只记入 errors、不影响其余——一个坏连接器不能拖垮整个 host。
// 依赖:node:child_process + 同层 stdio-transport/mcp-client。导出:connectMcpServers(及相关)。
import childProcess from 'node:child_process';
import { StdioTransport, type SpawnFn } from './stdio-transport.js';
import { McpClient } from './mcp-client.js';

// Connect a list of MCP server specs and import their tools into a registry.
//
// Each spec is { name, command, args?, env?, cwd?, timeoutMs? }. We spawn the
// server over stdio, run the initialize handshake, and namespace its tools as
// `mcp__<name>__<tool>` in the registry. A single server failing to connect is
// recorded in `errors` but never aborts the others, so one broken connector
// can't take down the whole host.
//
// Returns { clients: [{ name, client }], errors: [{ name, error }], toolCount }.

export type McpServerSpec = {
  name?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
};
export type McpRegistry = { registerMcpClient(name: string, client: McpClient): number | Promise<number> };
export type ConnectedMcpClient = { name: string; client: McpClient };
export type McpConnectError = { name: string; error: string };
export type ConnectMcpOptions = {
  registry?: McpRegistry;
  servers?: Array<McpServerSpec | null | undefined>;
  spawn?: SpawnFn;
  timeoutMs?: number;
};
export type ConnectMcpResult = { clients: ConnectedMcpClient[]; errors: McpConnectError[]; toolCount: number };

export async function connectMcpServers({
  registry,
  servers = [],
  spawn = childProcess.spawn as SpawnFn,
  timeoutMs = 15_000,
}: ConnectMcpOptions = {}): Promise<ConnectMcpResult> {
  if (!registry) {
    throw new Error('connectMcpServers: registry is required');
  }
  const clients: ConnectedMcpClient[] = [];
  const errors: McpConnectError[] = [];
  let toolCount = 0;

  for (const spec of servers) {
    if (!spec || !spec.name || !spec.command) {
      errors.push({ name: spec?.name || '(unnamed)', error: 'name and command are required' });
      continue;
    }
    try {
      const transport = new StdioTransport({
        command: spec.command,
        args: spec.args || [],
        env: spec.env || {},
        cwd: spec.cwd,
        spawn,
      });
      const client = new McpClient({ transport, timeoutMs: spec.timeoutMs || timeoutMs });
      const count = await registry.registerMcpClient(spec.name, client);
      clients.push({ name: spec.name, client });
      toolCount += count;
    } catch (err) {
      errors.push({ name: spec.name, error: err instanceof Error ? err.message : String(err) });
    }
  }

  return { clients, errors, toolCount };
}

export function closeMcpClients(clients: Array<ConnectedMcpClient | McpClient> = []): void {
  for (const entry of clients) {
    try {
      const client = entry instanceof McpClient ? entry : entry.client;
      client.close();
    } catch {
      // ignore
    }
  }
}
