import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { callThenAnswer, drainStream, readApprovalRequest } from './helpers/approvals.js';
import { noopKimiChatRunner } from './helpers/agent-stream.js';
import { bind, close, readableBody, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

function sseData(streamText: string, eventType: string): Record<string, unknown> {
  const match = new RegExp(`event: ${eventType}\\r?\\ndata: ([^\\r\\n]+)`).exec(streamText);
  assert.ok(match?.[1], `stream should contain ${eventType}`);
  return JSON.parse(match[1]) as Record<string, unknown>;
}

async function listTaskStatus(base: string, runId: string): Promise<string | undefined> {
  const res = await fetch(`${base}/api/tasks`);
  assert.equal(res.status, 200);
  const tasks = ((await res.json()) as { tasks?: Array<{ id: string; status: string }> }).tasks || [];
  return tasks.find((task) => task.id === runId)?.status;
}

test('E2E task center: running record appears, mid-run attach replays, approval works outside the chat stream', async () => {
  const root = tempRoot('acw-taskcenter-');
  const agentModelCall = callThenAnswer('Write', { path: 'out.md', content: '# 结果' });
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, trustedRoot: root, enableScheduler: false, requireAuth: false, modelChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const response = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '把结果写进 out.md' }),
    });
    const reader = readableBody(response, 'agent stream response').getReader();
    const approval = await readApprovalRequest(reader);
    const runId = String(sseData(approval.text, 'start').runId || '');
    assert.ok(runId && approval.approvalId);

    // run 挂起等审批时,任务中心已能看到 in_progress 任务(启动即写 running 档案)。
    assert.equal(await listTaskStatus(base, runId), 'in_progress');

    // 中途 attach 事件流:总线环形缓冲要能回放出同一个 approval_request。
    const attachAbort = new AbortController();
    const eventsRes = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/events`, {
      headers: { accept: 'text/event-stream' },
      signal: attachAbort.signal,
    });
    assert.equal(eventsRes.status, 200);
    const attachReader = readableBody(eventsRes, 'run events stream').getReader();
    const attached = await readApprovalRequest(attachReader);
    assert.equal(attached.approvalId, approval.approvalId);
    attachAbort.abort();

    // 在对话流之外(任务中心路径)批准,run 应继续并完成。
    const decide = await fetch(`${base}/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal(decide.status, 200);

    const chatAll = await drainStream(reader, approval.text);
    assert.match(chatAll, /event: approval_resolved/);
    assert.match(chatAll, /event: done/);

    // 收尾档案覆盖 running 初始档案,事件也随档案可回放。
    assert.equal(await listTaskStatus(base, runId), 'done');
  } finally {
    await close(server);
  }
});

test('E2E background run survives chat disconnect and finishes via task-center approval', async () => {
  const root = tempRoot('acw-bgrun-');
  const agentModelCall = callThenAnswer('Write', { path: 'bg.md', content: '# 后台产物' });
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, trustedRoot: root, enableScheduler: false, requireAuth: false, modelChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const chatAbort = new AbortController();
    const response = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '后台写文件', background: true }),
      signal: chatAbort.signal,
    });
    const reader = readableBody(response, 'agent stream response').getReader();
    const approval = await readApprovalRequest(reader);
    const runId = String(sseData(approval.text, 'start').runId || '');
    assert.ok(runId && approval.approvalId);

    // 模拟页面刷新/窗口关闭:切断对话 SSE。后台 run 不得被取消,审批也不得被清理。
    chatAbort.abort();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(await listTaskStatus(base, runId), 'in_progress', 'background run must survive the disconnect');

    const decide = await fetch(`${base}/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ decision: 'once' }),
    });
    assert.equal(decide.status, 200);

    let status: string | undefined;
    for (let i = 0; i < 50; i += 1) {
      status = await listTaskStatus(base, runId);
      if (status === 'done') break;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.equal(status, 'done', 'disconnected background run must finish after approval');
    assert.equal(fs.readFileSync(path.join(root, 'bg.md'), 'utf8'), '# 后台产物');
  } finally {
    await close(server);
  }
});
