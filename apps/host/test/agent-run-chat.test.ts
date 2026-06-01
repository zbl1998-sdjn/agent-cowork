import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import {
  hasTodoEvent,
  hasToolResultEvent,
  type EmittedEvent,
} from './helpers/agent.js';
import { tempRoot } from './helpers/host-http.js';
import type { ModelCall } from '../src/kimi/agent/model-resilience.js';

function ignoreEmit(type: string, payload: unknown): void {
  void type;
  void payload;
}

test('runAgentChat executes a Write tool call then returns a final answer', async () => {
  const root = tempRoot('kcw-agent-');
  const events: EmittedEvent[] = [];
  let calls = 0;
  const modelCall: ModelCall = async () => {
    calls += 1;
    if (calls === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'c1', function: { name: 'Write', arguments: JSON.stringify({ path: 'out.txt', content: 'hello agent' }) } }],
      };
    }
    return { content: '已为你创建 out.txt。' };
  };

  const out = await runAgentChat({
    prompt: '创建 out.txt',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    modelCall,
    emit: (type, payload) => events.push({ type, payload }),
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(fs.readFileSync(path.join(root, 'out.txt'), 'utf8'), 'hello agent');
  assert.ok(hasTodoEvent(events, 'running', '调用 Write'), 'tool todo starts running');
  assert.ok(hasTodoEvent(events, 'done', '调用 Write'), 'tool todo finishes done');
  assert.ok(hasToolResultEvent(events, 'Write'), 'tool result reports duration');
  assert.equal(out.text, '已为你创建 out.txt。');
});

test('a run that exhausts the step budget still returns a written reply', async () => {
  const root = tempRoot('kcw-agent-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'x', 'utf8');
  let toolCallId = 0;
  const modelCall: ModelCall = async ({ tools }) => {
    if (Array.isArray(tools) && tools.length > 0) {
      toolCallId += 1;
      return {
        content: '',
        tool_calls: [{ id: `c${toolCallId}`, function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*' }) } }],
      };
    }
    return { content: '【小结】我浏览了工作区。' };
  };

  const out = await runAgentChat({
    prompt: '看看这里',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    modelCall,
    maxSteps: 3,
    emit: ignoreEmit,
  });

  assert.ok(out.text.length > 0, 'final text must not be empty after budget exhaustion');
  assert.match(out.text, /小结|工作区/);
});

test('static backstop fires when even the forced summary comes back empty', async () => {
  const root = tempRoot('kcw-agent-');
  const modelCall: ModelCall = async ({ tools }) => {
    if (Array.isArray(tools) && tools.length > 0) {
      return { content: '', tool_calls: [{ id: 'z', function: { name: 'Glob', arguments: JSON.stringify({ pattern: '*' }) } }] };
    }
    return { content: '' };
  };

  const out = await runAgentChat({
    prompt: 'x',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    modelCall,
    maxSteps: 2,
    emit: ignoreEmit,
  });

  assert.ok(out.text.length > 0, 'static backstop must provide a non-empty reply');
});
