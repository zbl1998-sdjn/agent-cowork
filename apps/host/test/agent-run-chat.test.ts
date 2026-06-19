import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { addUsage, applyStaticBackstop, sse, summarizeAfterBudget } from '../src/kimi/agent/finalize.js';
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

function unexpectedEmit(message: string): never {
  throw new Error(message);
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

test('finalize helpers accumulate usage, write SSE frames, and respect aborts', () => {
  const usageTotals = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  addUsage(usageTotals, { prompt_tokens: '4', completion_tokens: 5, total_tokens: 6 });
  addUsage(usageTotals, null);

  assert.deepEqual(usageTotals, { prompt_tokens: 5, completion_tokens: 7, total_tokens: 9 });

  let chunk = '';
  sse({ write(value = '') { chunk += String(value); } }, 'done', { ok: true });
  assert.equal(chunk, 'event: done\ndata: {"ok":true}\n\n');

  const emitted: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const text = applyStaticBackstop('', null, (type, payload) => emitted.push({ type, payload }));
  assert.match(text, /继续/);
  assert.deepEqual(emitted, [{ type: 'token', payload: { delta: text } }]);

  const controller = new AbortController();
  controller.abort();
  assert.equal(applyStaticBackstop('', controller.signal, () => unexpectedEmit('aborted backstop must not emit')), '');
});

test('summarizeAfterBudget disables tools, emits streamed summary, and records usage', async () => {
  const messages: Array<{ role: string; content: unknown }> = [{ role: 'user', content: '读取项目' }];
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const seenTools: unknown[] = [];
  const modelCall: ModelCall = async (args) => {
    seenTools.push(args.tools);
    const callbacks = args as { onContent?: (delta: string) => void };
    callbacks.onContent?.('流式小结');
    return {
      content: '预算小结',
      usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
    };
  };

  const text = await summarizeAfterBudget({
    messages,
    modelCall,
    kimiConfig: { timeoutMs: 1000 },
    emit: (type, payload) => events.push({ type, payload }),
    usageTotals,
  });

  assert.equal(text, '预算小结');
  assert.deepEqual(seenTools, [[]]);
  assert.equal(messages.length, 2);
  assert.match(String(messages[1]?.content), /工具调用上限/);
  assert.deepEqual(events, [{ type: 'token', payload: { delta: '流式小结' } }]);
  assert.deepEqual(usageTotals, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
});

test('summarizeAfterBudget returns existing or empty text without leaking model failures', async () => {
  const throwingModel: ModelCall = async () => {
    throw new Error('network down');
  };
  const usageTotals = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  const existing = await summarizeAfterBudget({
    finalText: '已有答复',
    messages: [],
    modelCall: throwingModel,
    emit: () => unexpectedEmit('existing final text should not emit'),
    usageTotals,
  });
  assert.equal(existing, '已有答复');

  const failed = await summarizeAfterBudget({
    messages: [],
    modelCall: throwingModel,
    emit: () => unexpectedEmit('model failure should be swallowed'),
    usageTotals,
  });
  assert.equal(failed, '');
});
