// 端到端 Agent 链路冒烟(scripts · smoke·E2E)
// ---------------------------------------------------------------------------
// 职责:在本地拉起 Host 服务,通过 /api/agent/chat/stream 跑完一条完整 Agent 链路
//       (读取 input.txt → 写出 e2e-output.md → 执行无害 shell),消费 SSE 事件并
//       自动应答审批,断言出现 done、足够的工具结果、shell-ok 与产物文件,落地 JSON 报告。
//       默认 dry-run(注入假 ModelCall/KimiChatRunner);设 E2E_SMOKE_REAL/LIVE=1 且
//       提供 KIMI/MOONSHOT API key 时切换为 live 真模型模式。
// 用法:npm run smoke:e2e(即 node scripts/run-host-node.mjs scripts/e2e-smoke.ts);
//       失败即 exit 1 阻断,并写出 *-failed.json 报告。
// 依赖:apps/host 的 createServer;报告目录由 E2E_SMOKE_REPORT_DIR/WORKSPACE 覆盖。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';
import type { HostServer } from '../apps/host/src/server.js';
import type { ModelCall } from '../apps/host/src/engine/agent/model-resilience.js';
import type { KimiTextResult } from '../apps/host/src/engine/api-runner.js';

type StreamEvent = { event: string; data: unknown };
type JsonRecord = Record<string, unknown>;
type SmokeSummary = {
  start: boolean;
  toolCallCount: number;
  toolResultCount: number;
  shellResultCount: number;
  shellOk: boolean;
  approvals: number;
  fileWritten: boolean;
  done: boolean;
  errors: unknown[];
};

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reportRoot = path.resolve(process.env.E2E_SMOKE_REPORT_DIR || path.join(repoRoot, 'reports', 'e2e-smoke'));
const workspaceRoot = path.resolve(process.env.E2E_SMOKE_WORKSPACE || path.join(reportRoot, 'workspace'));
const liveRequested = process.env.E2E_SMOKE_REAL === '1' || process.env.E2E_SMOKE_LIVE === '1';
const apiKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
const mode = liveRequested && apiKey ? 'live' : 'dry-run';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function nowStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' ? value as JsonRecord : null;
}

function writeFixtureWorkspace(): void {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'input.txt'),
    'Agent Cowork E2E fixture. Please read, summarize, write e2e-output.md, and run a harmless shell check.',
    'utf8',
  );
}

async function bind(server: HostServer): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert(address && typeof address === 'object', 'server did not expose a TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function postJson(baseUrl: string, route: string, body: JsonRecord): Promise<unknown> {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert(response.ok, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function parseSseChunk(
  buffer: string,
  onEvent: (event: string, data: unknown) => void | Promise<void>,
): Promise<string> {
  let rest = buffer;
  for (;;) {
    const match = /\r?\n\r?\n/.exec(rest);
    if (!match) return rest;
    const raw = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    let event = 'message';
    const dataLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    let data: unknown = dataLines.join('\n');
    try {
      data = JSON.parse(String(data)) as unknown;
    } catch {
      /* keep text data */
    }
    await onEvent(event, data);
  }
}

async function runAgentStream(baseUrl: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  const response = await fetch(`${baseUrl}/api/agent/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt:
        'Run an E2E smoke in the trusted workspace: read input.txt, write e2e-output.md, then run `node -e "process.stdout.write(\'shell-ok\')"`. Keep all writes inside the workspace.',
      autoApprove: false,
      maxSteps: 8,
      verify: mode === 'dry-run',
    }),
  });
  assert(response.ok, `/api/agent/chat/stream returned ${response.status}`);
  assert(response.body, 'agent stream response did not include a readable body');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = await parseSseChunk(buffer, async (event, data) => {
      events.push({ event, data });
      const payload = asRecord(data);
      if (event === 'approval_request' && typeof payload?.id === 'string') {
        await postJson(baseUrl, `/api/approvals/${payload.id}`, { decision: 'once' });
      }
    });
  }
  await parseSseChunk(buffer, (event, data) => {
    events.push({ event, data });
  });
  return events;
}

function makeDryRunModelCall(): ModelCall {
  let step = 0;
  return async (args) => {
    const onContent = typeof args.onContent === 'function'
      ? args.onContent as (content: string) => unknown
      : undefined;
    step += 1;
    if (step === 1) {
      return {
        content: '',
        tool_calls: [
          { id: 'read_input', function: { name: 'Read', arguments: JSON.stringify({ path: 'input.txt' }) } },
        ],
      };
    }
    if (step === 2) {
      return {
        content: '',
        tool_calls: [
          {
            id: 'write_output',
            function: {
              name: 'Write',
              arguments: JSON.stringify({
                path: 'e2e-output.md',
                content: '# E2E Smoke\n\n- read: input.txt\n- write: e2e-output.md\n- shell: pending\n',
              }),
            },
          },
        ],
      };
    }
    if (step === 3) {
      return {
        content: '',
        tool_calls: [
          {
            id: 'shell_check',
            function: {
              name: 'Shell',
              arguments: JSON.stringify({ command: 'node -e "process.stdout.write(\'shell-ok\')"' }),
            },
          },
        ],
      };
    }
    if (step === 4) {
      return {
        content: '',
        tool_calls: [
          { id: 'verify_output', function: { name: 'Read', arguments: JSON.stringify({ path: 'e2e-output.md' }) } },
        ],
      };
    }
    onContent?.('E2E dry-run smoke completed.');
    return { content: 'E2E dry-run smoke completed.' };
  };
}

async function dryRunKimiChatRunner(): Promise<KimiTextResult> {
  return {
    ok: true,
    provider: 'test',
    model: 'dry-run',
    mode: 'chat',
    text: 'dry-run',
    durationMs: 0,
  };
}

function summarize(events: readonly StreamEvent[]): SmokeSummary {
  const eventNames = events.map((item) => item.event);
  const shellResults = events
    .filter((item) => item.event === 'tool_result' && asRecord(item.data)?.name === 'Shell')
    .map((item) => asRecord(asRecord(item.data)?.result) || {});
  const shellOk = shellResults.some((result) => result.exitCode === 0 && String(result.stdout || '').includes('shell-ok'));
  return {
    start: eventNames.includes('start'),
    toolCallCount: eventNames.filter((event) => event === 'tool_call').length,
    toolResultCount: eventNames.filter((event) => event === 'tool_result').length,
    shellResultCount: shellResults.length,
    shellOk,
    approvals: eventNames.filter((event) => event === 'approval_request').length,
    fileWritten: eventNames.includes('file_written'),
    done: eventNames.includes('done'),
    errors: events.filter((item) => item.event === 'error').map((item) => item.data),
  };
}

async function main(): Promise<void> {
  fs.mkdirSync(reportRoot, { recursive: true });
  writeFixtureWorkspace();

  const server = createServer({
    trustedRoot: workspaceRoot,
    staticRoot: false,
    requireAuth: false,
    enableScheduler: false,
    ...(mode === 'dry-run' ? {
      agentModelCall: makeDryRunModelCall(),
      kimiChatRunner: dryRunKimiChatRunner,
    } : {}),
    ...(apiKey ? { kimiApiKey: apiKey } : {}),
    ...(process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL
      ? { kimiBaseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL }
      : {}),
    ...(process.env.KIMI_MODEL ? { kimiModel: process.env.KIMI_MODEL } : {}),
    kimiApiTimeoutMs: Number(process.env.KIMI_API_TIMEOUT_MS || 90_000),
  });

  const startedAt = Date.now();
  const reportPath = path.join(reportRoot, `e2e-smoke-${nowStamp()}.json`);
  let baseUrl: string | null = null;
  try {
    baseUrl = await bind(server);
    const events = await runAgentStream(baseUrl);
    const outputPath = path.join(workspaceRoot, 'e2e-output.md');
    const outputExists = fs.existsSync(outputPath);
    const summary = summarize(events);
    assert(summary.done, 'agent stream did not emit done');
    assert(summary.toolResultCount >= 2, 'agent stream did not exercise enough tool results');
    assert(summary.shellOk, 'agent stream did not capture shell-ok from Shell stdout');
    assert(outputExists, 'e2e-output.md was not written');

    const report = {
      ok: true,
      mode,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workspace: workspaceRoot,
      baseUrl,
      outputPath,
      summary,
      events,
      livePrerequisites: {
        requested: liveRequested,
        hasApiKey: Boolean(apiKey),
        baseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL || null,
        model: process.env.KIMI_MODEL || null,
      },
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, mode, reportPath, summary }, null, 2));
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error) => {
  fs.mkdirSync(reportRoot, { recursive: true });
  const reportPath = path.join(reportRoot, `e2e-smoke-${nowStamp()}-failed.json`);
  const report = {
    ok: false,
    mode,
    generatedAt: new Date().toISOString(),
    workspace: workspaceRoot,
    error: error instanceof Error ? (error.stack || error.message) : String(error),
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error instanceof Error ? (error.stack || error.message) : String(error));
  process.exit(1);
});
