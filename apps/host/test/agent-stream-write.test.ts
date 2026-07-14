import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { runsIndexSchema } from './helpers/agent.js';
import { noopKimiChatRunner, readAgentStream } from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';
import type { ModelCall } from '../src/engine/agent/model-resilience.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

test('POST /api/agent/chat/stream (autoApprove) writes the file and records an agent-chat run', async () => {
  const root = tempRoot('kcw-agent-');
  let calls = 0;
  const agentModelCall: ModelCall = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'note.md', content: '# 标题\n内容' }) } }],
      };
    }
    return { content: '已写入 note.md。' };
  };
  const server = createServer({
    ...TEST_LOCAL_HOST_MODEL_CONFIG,
    trustedRoot: root,
    enableScheduler: false,
    modelChatRunner: noopKimiChatRunner,
    agentModelCall,
  });
  const base = await bind(server);

  try {
    const response = await fetch(`${base}/api/agent/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: '写 note.md', autoApprove: true }),
    });
    assert.equal(response.status, 200);

    const streamText = await readAgentStream(response);
    assert.match(streamText, /event: tool_call/);
    assert.match(streamText, /event: todo_update/);
    assert.match(streamText, /event: done/);
    assert.equal(fs.readFileSync(path.join(root, 'note.md'), 'utf8'), '# 标题\n内容');

    const runsIndex = runsIndexSchema.parse(await (await fetch(`${base}/api/runs/index`)).json() as unknown);
    assert.ok(runsIndex.runs?.some((run) => run.type === 'agent-chat'));
  } finally {
    await close(server);
  }
});
