import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import {
  hasToolResult,
  noopKimiChatRunner,
  postAgentStream,
  readAgentStream,
  startRunId,
  toolNames,
  type AgentModelCallInput,
} from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

test('E2E /api/agent/chat/stream: lazy tools — connected mcp tools hidden until search_tools activates them', async () => {
  const root = tempRoot('kcw-e2e-');
  fs.writeFileSync(path.join(root, 'hi.txt'), 'hi', 'utf8');
  const seen: string[][] = [];
  let n = 0;
  const agentModelCall = async ({ tools }: AgentModelCallInput) => {
    seen.push(toolNames(tools));
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'search_tools', arguments: JSON.stringify({ query: 'fs list dir' }) } }] };
    return { content: '已检索到可用工具。' };
  };
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const conn = await fetch(`${base}/api/connectors/connect`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'filesystem', trustedRoot: root }),
    });
    assert.equal(conn.status, 200);
    const res = await postAgentStream(base, { prompt: '列目录', autoApprove: true });
    const all = await readAgentStream(res);
    assert.match(all, /event: done/);
    assert.ok(seen[0]?.includes('search_tools'), 'search_tools meta-tool exposed initially');
    assert.ok(!seen[0]?.some((name) => name.startsWith('mcp__fs__')), 'mcp tools hidden on the first turn');
    assert.ok(seen[1]?.some((name) => name.startsWith('mcp__fs__')), 'mcp tool activated after search_tools');
  } finally {
    await close(server);
  }
});

test('E2E /api/agent/chat/stream: resumeRunId continues from checkpoint without replaying writes', async () => {
  const root = tempRoot('kcw-e2e-');
  let firstRunCalls = 0;
  let resumeMode = false;
  let resumedSawToolResult = false;
  const agentModelCall = async ({ messages }: AgentModelCallInput) => {
    if (resumeMode && hasToolResult(messages, 'c1')) {
      resumedSawToolResult = true;
      return { content: '续跑完成。', usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 } };
    }
    if (!resumeMode) {
      firstRunCalls += 1;
      if (firstRunCalls === 1) {
        return {
          content: '',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          tool_calls: [{
            id: 'c1',
            function: { name: 'Write', arguments: JSON.stringify({ path: 'resume.txt', content: 'first' }) },
          }],
        };
      }
      throw new Error('simulated crash after checkpoint');
    }
    return {
      content: '',
      tool_calls: [{
        id: 'c_replay',
        function: { name: 'Write', arguments: JSON.stringify({ path: 'resume.txt', content: 'replayed' }) },
      }],
    };
  };
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, kimiChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const first = await postAgentStream(base, { prompt: '写入后模拟崩溃', autoApprove: true });
    const firstText = await readAgentStream(first);
    assert.match(firstText, /event: error/);
    const runId = startRunId(firstText);
    assert.equal(fs.readFileSync(path.join(root, 'resume.txt'), 'utf8'), 'first');

    resumeMode = true;
    const resumed = await postAgentStream(base, { resumeRunId: runId, autoApprove: true });
    assert.equal(resumed.status, 200);
    const resumedText = await readAgentStream(resumed);
    assert.match(resumedText, /"resumed":true/);
    assert.match(resumedText, /event: done/);
    assert.match(resumedText, /续跑完成/);
    assert.equal(resumedSawToolResult, true);
    assert.equal(fs.readFileSync(path.join(root, 'resume.txt'), 'utf8'), 'first');
  } finally {
    await close(server);
  }
});
