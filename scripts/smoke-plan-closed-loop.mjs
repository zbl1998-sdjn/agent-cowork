import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../apps/host/src/server.js';

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const buildRoot = path.join(repoRoot, 'build');
const defaultReportPath = path.join(buildRoot, 'plan-closed-loop-smoke-report.json');
const archiveRequested = process.env.PLAN_LOOP_ARCHIVE === '1';
const reportRoot = path.resolve(process.env.PLAN_LOOP_REPORT_DIR || path.join(repoRoot, 'reports', 'plan-closed-loop'));
const workspaceRoot = path.resolve(process.env.PLAN_LOOP_WORKSPACE || path.join(buildRoot, 'plan-closed-loop-workspace'));
const reportPath = archiveRequested
  ? path.join(reportRoot, `plan-closed-loop-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  : defaultReportPath;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function writeFixtureWorkspace() {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  fs.mkdirSync(path.join(workspaceRoot, 'research'), { recursive: true });
  fs.writeFileSync(
    path.join(workspaceRoot, 'research', 'product.md'),
    [
      '# Product Notes',
      '',
      '- Agent Cowork must keep user-visible plans before edits.',
      '- The release slice needs multi-file evidence, not a single-file demo.',
      '- Final answers should include what was checked.',
      '',
    ].join('\n'),
    'utf8',
  );
  fs.writeFileSync(
    path.join(workspaceRoot, 'research', 'risks.md'),
    [
      '# Risk Notes',
      '',
      '- Mutating work needs approval.',
      '- Self-check must read back generated files.',
      '- Reports should leave a reproducible evidence trail.',
      '',
    ].join('\n'),
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

async function runPlanStream(baseUrl) {
  const events = [];
  const response = await fetch(`${baseUrl}/api/agent/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt:
        'Run a plan-mode closed-loop smoke: research research/*.md, propose a plan, wait for approval, write two deliverables, self-check them, and finish in Chinese.',
      autoApprove: false,
      planMode: true,
      verify: true,
      maxSteps: 10,
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
      if (event === 'plan_proposed' && data && data.id) {
        await postJson(baseUrl, `/api/approvals/${data.id}`, { decision: 'once' });
      }
      if (event === 'approval_request' && data && data.id) {
        await postJson(baseUrl, `/api/approvals/${data.id}`, { decision: 'once' });
      }
    });
  }
  await parseSseChunk(buffer, (event, data) => events.push({ event, data }));
  return events;
}

function makeClosedLoopModelCall() {
  let step = 0;
  return async () => {
    step += 1;
    if (step === 1) {
      return {
        content: '',
        tool_calls: [
          { id: 'glob_research', function: { name: 'Glob', arguments: JSON.stringify({ pattern: 'research/*.md' }) } },
        ],
      };
    }
    if (step === 2) {
      return {
        content: '',
        tool_calls: [
          { id: 'read_product', function: { name: 'Read', arguments: JSON.stringify({ path: 'research/product.md' }) } },
          { id: 'read_risks', function: { name: 'Read', arguments: JSON.stringify({ path: 'research/risks.md' }) } },
        ],
      };
    }
    if (step === 3) {
      return {
        content: '',
        tool_calls: [
          {
            id: 'exit_plan',
            function: {
              name: 'ExitPlanMode',
              arguments: JSON.stringify({
                plan: [
                  '1. 研究 research/product.md 和 research/risks.md',
                  '2. 写 deliverables/project-brief.md',
                  '3. 写 deliverables/checklist.md',
                  '4. 读回两个产物做自检',
                  '5. 收尾说明已完成的检查',
                ].join('\n'),
              }),
            },
          },
        ],
      };
    }
    if (step === 4) {
      return {
        content: '',
        tool_calls: [
          {
            id: 'write_brief',
            function: {
              name: 'Write',
              arguments: JSON.stringify({
                path: 'deliverables/project-brief.md',
                content: [
                  '# Project Brief',
                  '',
                  '- Plan-first execution is required before mutating work.',
                  '- The releasable slice must prove a multi-file workflow.',
                  '- Final output must mention the self-check evidence.',
                  '',
                ].join('\n'),
              }),
            },
          },
          {
            id: 'write_checklist',
            function: {
              name: 'Write',
              arguments: JSON.stringify({
                path: 'deliverables/checklist.md',
                content: [
                  '# Closed-loop Checklist',
                  '',
                  '- [x] Researched both source files',
                  '- [x] Proposed a user-visible plan',
                  '- [x] Wrote two deliverables after approval',
                  '- [x] Self-check reads back generated files',
                  '',
                ].join('\n'),
              }),
            },
          },
        ],
      };
    }
    if (step === 5) return { content: '初稿已完成，准备自检。' };
    if (step === 6) {
      return {
        content: '',
        tool_calls: [
          { id: 'check_brief', function: { name: 'Read', arguments: JSON.stringify({ path: 'deliverables/project-brief.md' }) } },
          { id: 'check_checklist', function: { name: 'Read', arguments: JSON.stringify({ path: 'deliverables/checklist.md' }) } },
        ],
      };
    }
    return { content: '已完成研究、计划、批准后执行、自检和收尾。' };
  };
}

function summarize(events) {
  const eventNames = events.map((item) => item.event);
  const toolNames = events.filter((item) => item.event === 'tool_call').map((item) => item.data?.name);
  return {
    start: eventNames.includes('start'),
    planProposed: eventNames.includes('plan_proposed'),
    todoSnapshot: eventNames.includes('todo_snapshot'),
    verifyStart: eventNames.includes('verify_start'),
    done: eventNames.includes('done'),
    toolNames,
    toolCallCount: toolNames.length,
    toolResultCount: eventNames.filter((event) => event === 'tool_result').length,
    fileWrittenCount: eventNames.filter((event) => event === 'file_written').length,
    errors: events.filter((item) => item.event === 'error').map((item) => item.data),
  };
}

async function main() {
  fs.mkdirSync(buildRoot, { recursive: true });
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFixtureWorkspace();

  const server = createServer({
    trustedRoot: workspaceRoot,
    staticRoot: false,
    requireAuth: false,
    enableScheduler: false,
    agentModelCall: makeClosedLoopModelCall(),
    kimiChatRunner: async () => ({ ok: true, text: 'dry-run' }),
  });

  const startedAt = Date.now();
  let baseUrl = null;
  try {
    baseUrl = await bind(server);
    const events = await runPlanStream(baseUrl);
    const briefPath = path.join(workspaceRoot, 'deliverables', 'project-brief.md');
    const checklistPath = path.join(workspaceRoot, 'deliverables', 'checklist.md');
    const summary = summarize(events);

    assert(summary.start, 'agent stream did not emit start');
    assert(summary.planProposed, 'plan was not proposed');
    assert(summary.todoSnapshot, 'todo snapshot was not emitted from the approved plan');
    assert(summary.verifyStart, 'self-check did not start after approved plan execution');
    assert(summary.done, 'agent stream did not emit done');
    assert(summary.toolNames.includes('Glob'), 'research glob did not run');
    assert(summary.toolNames.includes('ExitPlanMode'), 'ExitPlanMode did not run');
    assert(summary.toolNames.filter((name) => name === 'Write').length >= 2, 'expected two writes');
    assert(summary.toolNames.filter((name) => name === 'Read').length >= 4, 'expected research and self-check reads');
    assert(fs.existsSync(briefPath), 'project brief was not written');
    assert(fs.existsSync(checklistPath), 'checklist was not written');
    assert(fs.readFileSync(briefPath, 'utf8').includes('Plan-first execution'), 'brief content mismatch');
    assert(fs.readFileSync(checklistPath, 'utf8').includes('Self-check reads back'), 'checklist content mismatch');

    const report = {
      ok: true,
      generatedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      workspace: workspaceRoot,
      baseUrl,
      reportPath,
      artifacts: { briefPath, checklistPath },
      summary,
      events,
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ ok: true, reportPath, summary }, null, 2));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((error) => {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    ok: false,
    generatedAt: new Date().toISOString(),
    workspace: workspaceRoot,
    reportPath,
    error: error.stack || error.message,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.error(error.stack || error.message);
  process.exit(1);
});
