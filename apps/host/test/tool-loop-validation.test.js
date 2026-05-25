import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/kimi/agent-runner.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-tool-loop-validation-'));
}

test('runAgentChat rejects invalid tool arguments before calling the handler', async () => {
  const root = tmp();
  const events = [];
  let toolRuns = 0;
  const tools = [{
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
  let validationMessage = null;
  const modelCall = async ({ messages }) => {
    calls += 1;
    if (calls === 1) {
      return { content: '', tool_calls: [{ id: 'write_1', function: { name: 'WriteReport', arguments: '{"path":42}' } }] };
    }
    validationMessage = messages.at(-1);
    return { content: 'args rejected' };
  };

  const out = await runAgentChat({
    prompt: 'write report',
    kimiConfig: { model: 'fake' },
    trustedRoot: root,
    tools,
    modelCall,
    emit: (type, payload) => events.push({ type, payload }),
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(out.text, 'args rejected');
  assert.equal(toolRuns, 0);
  assert.match(validationMessage.content, /invalid tool arguments/i);
  assert.match(validationMessage.content, /path/);
  assert.match(validationMessage.content, /content/);
  assert.ok(events.some((event) => event.type === 'tool_args_invalid'
    && event.payload.name === 'WriteReport'
    && event.payload.errors.length >= 2));
});
