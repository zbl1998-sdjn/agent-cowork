import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reportRoot = path.resolve(process.env.E2E_SMOKE_REPORT_DIR || path.join(repoRoot, 'reports', 'e2e-smoke'));
const workspaceRoot = path.resolve(process.env.E2E_SMOKE_WORKSPACE || path.join(reportRoot, 'workspace'));
const liveRequested = process.env.E2E_SMOKE_REAL === '1' || process.env.E2E_SMOKE_LIVE === '1';
const apiKey = process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY;
const mode = liveRequested && apiKey ? 'live' : 'dry-run';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeFixtureWorkspace() {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'input.txt'),
    'Agent Cowork E2E fixture. Please read, summarize, write e2e-output.md, and run a harmless shell check.',
    'utf8',
  );
}

async function bind(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return `http://127.0.0.1:${server.address().port}`;
}

async function postJson(baseUrl, route, body) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json();
  assert(response.ok, `${route} returned ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function parseSseChunk(buffer, onEvent) {
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
    let data = dataLines.join('\n');
    try {
      data = JSON.parse(data);
    } catch {
      /* keep text data */
    }
    await onEvent(event, data);
  }
}

async function runAgentStream(baseUrl) {
  const events = [];
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

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = await parseSseChunk(buffer, async (event, data) => {
      events.push({ event, data });
      if (event === 'approval_request' && data && data.id) {
        await postJson(baseUrl, `/api/approvals/${data.id}`, { decision: 'once' });
      }
    });
  }
  await parseSseChunk(buffer, (event, data) => events.push({ event, data }));
  return events;
}

function makeDryRunModelCall() {
  let step = 0;
  return async ({ onContent }) => {
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

function summarize(events) {
  const eventNames = events.map((item) => item.event);
  const shellResults = events
    .filter((item) => item.event === 'tool_result' && item.data?.name === 'Shell')
    .map((item) => item.data?.result || {});
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

async function main() {
  fs.mkdirSync(reportRoot, { recursive: true });
  writeFixtureWorkspace();

  const server = createServer({
    trustedRoot: workspaceRoot,
    staticRoot: false,
    requireAuth: false,
    enableScheduler: false,
    agentModelCall: mode === 'dry-run' ? makeDryRunModelCall() : undefined,
    kimiChatRunner: mode === 'dry-run' ? async () => ({ ok: true, text: 'dry-run' }) : undefined,
    kimiApiKey: apiKey,
    kimiBaseUrl: process.env.KIMI_BASE_URL || process.env.MOONSHOT_BASE_URL,
    kimiModel: process.env.KIMI_MODEL,
    kimiApiTimeoutMs: Number(process.env.KIMI_API_TIMEOUT_MS || 90_000),
  });

  const startedAt = Date.now();
  const reportPath = path.join(reportRoot, `e2e-smoke-${nowStamp()}.json`);
  let baseUrl = null;
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
    await new Promise((resolve) => server.close(resolve));
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
    error: error.stack || error.message,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error.stack || error.message);
  process.exit(1);
});
