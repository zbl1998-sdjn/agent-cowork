import childProcess from 'node:child_process';
import { StdioTransport } from './stdio-transport.js';
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

export async function connectMcpServers({ registry, servers = [], spawn = childProcess.spawn, timeoutMs = 15_000 } = {}) {
  if (!registry) {
    throw new Error('connectMcpServers: registry is required');
  }
  const clients = [];
  const errors = [];
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
      errors.push({ name: spec.name, error: err.message });
    }
  }

  return { clients, errors, toolCount };
}

export function closeMcpClients(clients = []) {
  for (const entry of clients) {
    try {
      (entry.client || entry).close();
    } catch {
      // ignore
    }
  }
}
