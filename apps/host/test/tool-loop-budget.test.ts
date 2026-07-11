import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createBudgetGuard } from '../src/runtime/budget-guard.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import type { AgentTool } from '../src/kimi/agent-tools.js';

type EmittedEvent = {
  type: string;
  payload: unknown;
};

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-tool-loop-budget-'));
}

function isMaxRunTokensAbort(event: EmittedEvent): boolean {
  if (event.type !== 'budget_guard_abort' || !event.payload || typeof event.payload !== 'object') return false;
  return (event.payload as { limit?: unknown }).limit === 'maxRunTokens';
}

test('runAgentChat stops safely when model usage exceeds the run token budget before tools run', async () => {
  const root = tmp();
  const events: EmittedEvent[] = [];
  let writes = 0;
  const tools: AgentTool[] = [{
    name: 'WriteReport',
    risk: 'safe',
    mutating: true,
    description: 'Writes a report',
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      writes += 1;
      return { ok: true, path: 'report.md' };
    },
  }];
  const modelCall = async () => ({
    content: '',
    usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 },
    tool_calls: [{ id: 'write_1', function: { name: 'WriteReport', arguments: '{}' } }],
  });

  const out = await runAgentChat({
    prompt: 'write',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools,
    modelCall,
    budgetGuard: createBudgetGuard({ maxRunTokens: 10 }),
    emit: (type, payload) => events.push({ type, payload }),
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(writes, 0);
  assert.equal(out.budgetStopped, true);
  assert.match(out.text, /预算|budget|token/i);
  assert.ok(events.some(isMaxRunTokensAbort));
});
