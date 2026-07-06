// 确定性烟雾:走真实路径验证「MASE 作为 agent cowork 记忆后端」的读写桥接。
//   connectMcpServers(注册 mcp__mase-memory__* 到 ToolRegistry)
//     → maseRememberTurn(写一轮) → maseRecallSessionMemory(召回并拼成会话记忆块)。
// 用法:MASE_REPO=<本机 MASE 仓库路径> node scripts/run-host-node.mjs scripts/smoke-mase-memory-bridge.ts
//   可选:MASE_CONFIG_PATH(默认 <MASE_REPO>\config.json)、MASE_MEMORY_DIR。
// MASE_REPO 指向的外部仓库不随本仓库分发,需按 .env.example 第 9 节自行准备。
import { createToolRegistry } from '../apps/host/src/tools/tool-registry.js';
import { connectMcpServers } from '../apps/host/src/mcp/connect.js';
import { maseRecallSessionMemory, maseRememberTurn } from '../apps/host/src/memory/mase-bridge.js';

function requireMaseRepo(): string {
  const repo = process.env.MASE_REPO;
  if (!repo) {
    console.error('[bridge-smoke] FAILED: set MASE_REPO to a local MASE checkout before running this smoke (see .env.example section 9).');
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
  const registry = createToolRegistry();
  const outcome = await connectMcpServers({
    registry,
    servers: [
      {
        name: 'mase-memory',
        command: 'python',
        args: ['-m', 'integrations.mcp_server.server'],
        cwd: repo,
        env: MASE_ENV,
        timeoutMs: 60_000,
      },
    ],
  });
  console.log('[bridge-smoke] tools registered:', outcome.toolCount, '| errors:', JSON.stringify(outcome.errors));
  console.log('[bridge-smoke] recall tool present:', registry.has('mcp__mase-memory__mase_recall'));

  // 写缝:模拟一轮对话写回 MASE。
  await maseRememberTurn(
    registry,
    '我的部署窗口是每周三晚上,代号 NightShift。',
    '收到,已记下你的部署窗口(每周三晚)与代号 NightShift。',
    'bridge-smoke',
  );
  console.log('[bridge-smoke] remembered one turn');

  // 读缝:用相关问题召回 → 应拼成 sessionMemory 文本,并包含刚写入的事实。
  const block = await maseRecallSessionMemory(registry, '我的部署窗口和代号是什么', 'bridge-smoke', 5);
  console.log('[bridge-smoke] recalled sessionMemory block:\n' + (block || '(empty)'));
  console.log('[bridge-smoke] contains NightShift:', block.includes('NightShift'));

  for (const name of registry.mcpServers()) registry.unregisterMcpServer(name);
}

main().then(
  () => setTimeout(() => process.exit(0), 200),
  (err) => {
    console.error('[bridge-smoke] FAILED:', err instanceof Error ? err.stack || err.message : err);
    setTimeout(() => process.exit(1), 200);
  },
);
