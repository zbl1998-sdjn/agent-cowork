// 确定性烟雾:用 agent cowork 真实的 StdioTransport + McpClient 连 MASE MCP server,
// 直接调 mase_remember / mase_recall,证明 host 的 MCP 接线端到端打通(不需要 Kimi 额度)。
// 用法:MASE_REPO=<本机 MASE 仓库路径> node scripts/run-host-node.mjs scripts/smoke-mase-mcp.ts
//   可选:MASE_CONFIG_PATH(默认 <MASE_REPO>\config.json)、MASE_MEMORY_DIR。
// 依赖:apps/host 的 mcp/stdio-transport 与 mcp/mcp-client(与正式连接器同一套实现);
//   MASE_REPO 指向的外部仓库不随本仓库分发,需按 .env.example 第 9 节自行准备。
import { StdioTransport } from '../apps/host/src/mcp/stdio-transport.js';
import { McpClient } from '../apps/host/src/mcp/mcp-client.js';

function requireMaseRepo(): string {
  const repo = process.env.MASE_REPO;
  if (!repo) {
    console.error('[smoke] FAILED: set MASE_REPO to a local MASE checkout before running this smoke (see .env.example section 9).');
    process.exit(1);
  }
  return repo;
}
const repo = requireMaseRepo();

const MASE_ENV: Record<string, string | undefined> = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  PYTHONUTF8: '1',
  PYTHONPATH: `${repo};${repo}\\src`,
  MASE_CONFIG_PATH: process.env.MASE_CONFIG_PATH || `${repo}\\config.json`,
  MASE_MEMORY_DIR: process.env.MASE_MEMORY_DIR,
  MASE_ALLOW_CLOUD_MODELS: '0',
};

async function main(): Promise<void> {
  const transport = new StdioTransport({
    command: 'python',
    args: ['-m', 'integrations.mcp_server.server'],
    cwd: repo,
    env: MASE_ENV,
  });
  const client = new McpClient({ transport, timeoutMs: 60_000 });

  console.log('[smoke] connecting to mase-memory MCP server (stdio)...');
  const info = await client.connect();
  console.log('[smoke] serverInfo:', JSON.stringify(info));

  const tools = (await client.listTools()) as Array<{ name?: string }>;
  console.log('[smoke] tools exposed:', tools.map((t) => t.name).filter(Boolean).join(', '));

  const remember = await client.callTool('mase_remember', {
    text: '烟雾测试(MCP):agent cowork 通过真实 MCP 客户端接入 MASE。前端端口契约=5173,项目代号=Phoenix。',
    thread_id: 'smoke::agentcowork',
  });
  console.log('[smoke] mase_remember ->', JSON.stringify(remember));

  const recall = await client.callTool('mase_recall', { query: 'agent cowork 项目代号 端口', top_k: 3 });
  console.log('[smoke] mase_recall ->', JSON.stringify(recall));

  client.close();
}

main().then(
  () => setTimeout(() => process.exit(0), 200),
  (err) => {
    console.error('[smoke] FAILED:', err instanceof Error ? err.stack || err.message : err);
    setTimeout(() => process.exit(1), 200);
  },
);
