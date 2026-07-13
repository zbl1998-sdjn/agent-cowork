import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/engine/agent-runner.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { ChatMessage } from '../src/engine/agent/tool-loop-types.js';
import type { AgentTool } from '../src/engine/agent/tool-call-executor.js';
import type { ModelCall } from '../src/engine/agent/model-resilience.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-tool-loop-validation-'));
}

type EmittedEvent = { type: string; payload: Record<string, unknown> };

function messageArray(value: unknown): ChatMessage[] {
  return Array.isArray(value) ? value as ChatMessage[] : [];
}

function lastMessage(value: unknown): ChatMessage {
  const message = messageArray(value).at(-1);
  assert.ok(message);
  return message;
}

function recordPayload(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('runAgentChat rejects invalid tool arguments before calling the handler', async () => {
  const root = tmp();
  const events: EmittedEvent[] = [];
  let toolRuns = 0;
  const tools: AgentTool[] = [{
    name: 'WriteReport',
    risk: 'low',
    mutating: true,
    description: 'Writes a report',
    parameters: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
      },
    },
    handler: async () => {
      toolRuns += 1;
      return { ok: true };
    },
  }];
  let calls = 0;
  let validationMessage: ChatMessage | null = null;
  const modelCall: ModelCall = async (args) => {
    calls += 1;
    if (calls === 1) {
      return { content: '', tool_calls: [{ id: 'write_1', function: { name: 'WriteReport', arguments: '{"path":42}' } }] };
    }
    validationMessage = lastMessage(args.messages);
    return { content: 'args rejected' };
  };

  const out = await runAgentChat({
    prompt: 'write report',
    modelConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall,
    emit: (type, payload) => events.push({ type, payload: recordPayload(payload) }),
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(out.text, 'args rejected');
  assert.equal(toolRuns, 0);
  const validationContent = String(recordPayload(validationMessage).content || '');
  assert.match(validationContent, /invalid tool arguments/i);
  assert.match(validationContent, /path/);
  assert.match(validationContent, /content/);
  assert.ok(events.some((event) => {
    const payload = recordPayload(event.payload);
    const errors = payload.errors;
    return event.type === 'tool_args_invalid'
      && payload.name === 'WriteReport'
      && Array.isArray(errors)
      && errors.length >= 2;
  }));
});
