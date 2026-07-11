import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runAgentChat } from '../src/kimi/agent-runner.js';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { ToolRegistry } from '../src/tools/tool-registry.js';
import { TEST_LOCAL_MODEL_CONFIG } from './helpers/kimi-config.js';
import { makeTestWorkspace } from './test-fixtures.js';
import type { AgentTool } from '../src/kimi/agent-tools.js';
import type { ChatMessage } from '../src/kimi/agent/tool-loop-types.js';
import type { ModelCall } from '../src/kimi/agent/model-resilience.js';
import type { ToolEntry } from '../src/tools/tool-registry.js';

const ALICE = Object.freeze({ tenantId: 'tenant_test', userId: 'alice' });
const BOB = Object.freeze({ tenantId: 'tenant_test', userId: 'bob' });

function workspace(label: string): string {
  return makeTestWorkspace(`kcw-builtin-boundary-${label}`);
}

function entry(name: string): ToolEntry {
  const found = createBuiltinTools({ sandbox: null }).find((tool) => tool.name === name);
  assert.ok(found, `${name} should be registered`);
  return found;
}

function agentTool(name: string, root: string): AgentTool & { handler: NonNullable<AgentTool['handler']> } {
  const found = createAgentTools({ trustedRoot: root, context: ALICE }).find((tool) => tool.name === name);
  assert.ok(found?.handler, `${name} should be registered`);
  return found as AgentTool & { handler: NonNullable<AgentTool['handler']> };
}

function isBadInput(error: unknown): boolean {
  const candidate = error as { statusCode?: unknown; message?: unknown };
  return candidate.statusCode === 400 && /argument|property|allowed|object/i.test(String(candidate.message || ''));
}

test('direct builtin handlers reject caller-controlled security and unknown fields', async () => {
  const root = workspace('server');
  const attackerRoot = workspace('attacker');
  fs.writeFileSync(path.join(root, 'sales.csv'), 'name,value\nALICE_ONLY,1\n', 'utf8');
  fs.writeFileSync(path.join(attackerRoot, 'sales.csv'), 'name,value\nBOB_ONLY,2\n', 'utf8');
  fs.writeFileSync(path.join(root, 'note.txt'), 'ALICE_ONLY', 'utf8');
  fs.writeFileSync(path.join(attackerRoot, 'note.txt'), 'BOB_ONLY', 'utf8');

  const cases: Array<{ name: string; args: Record<string, unknown> }> = [
    { name: 'data.profile', args: { path: 'sales.csv', trustedRoot: attackerRoot } },
    { name: 'data.analyze', args: { path: 'sales.csv', trustedRoot: attackerRoot } },
    { name: 'data.createChartArtifact', args: { path: 'sales.csv', id: 'boundary_chart', context: BOB } },
    { name: 'file.plan-organize', args: { files: ['note.txt'], mode: 'rename', trustedRoot: attackerRoot } },
  ];

  for (const item of cases) {
    await assert.rejects(
      () => Promise.resolve(entry(item.name).handler(item.args, { trustedRoot: root, context: ALICE })),
      isBadInput,
      `${item.name} must reject caller-controlled boundary fields`,
    );
  }
});

test('builtin argument projection rejects exotic objects without invoking getters or proxy traps', async () => {
  const root = workspace('objects');
  fs.writeFileSync(path.join(root, 'sales.csv'), 'name,value\na,1\n', 'utf8');
  const profile = entry('data.profile');
  const cases: unknown[] = [
    Object.assign([], { path: 'sales.csv' }),
    new (class Args { path = 'sales.csv'; })(),
    Object.assign(Object.create({ inherited: true }) as object, { path: 'sales.csv' }),
    { path: 'sales.csv', extra: true },
    JSON.parse('{"path":"sales.csv","__proto__":{}}'),
    JSON.parse('{"path":"sales.csv","constructor":{}}'),
    Object.defineProperty({}, 'path', { value: 'sales.csv', enumerable: false }),
    Object.assign({ path: 'sales.csv' }, { [Symbol('extra')]: true }),
    new Proxy({ path: 'sales.csv' }, { ownKeys() { throw new Error('ownKeys trap'); } }),
  ];
  let getterRuns = 0;
  cases.push(Object.defineProperty({}, 'path', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return 'sales.csv';
    },
  }));

  for (const rawArgs of cases) {
    await assert.rejects(
      () => Promise.resolve(profile.handler(rawArgs, { trustedRoot: root, context: ALICE })),
      isBadInput,
    );
  }
  assert.equal(getterRuns, 0, 'argument validation must not execute accessors');

  const proxyTrapRuns = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 };
  const hostileProxy = new Proxy({ path: 'sales.csv' }, {
    getPrototypeOf(target) {
      proxyTrapRuns.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      proxyTrapRuns.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      proxyTrapRuns.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) {
      proxyTrapRuns.get += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(
    () => Promise.resolve(profile.handler(hostileProxy, { trustedRoot: root, context: ALICE })),
    isBadInput,
  );
  assert.deepEqual(proxyTrapRuns, {
    getPrototypeOf: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
    get: 0,
  }, 'proxy rejection must not invoke any user-defined trap');
});

test('boundary-sensitive schemas are closed and normal calls keep working', async () => {
  const root = workspace('normal');
  fs.writeFileSync(path.join(root, 'sales.csv'), 'name,value\na,1\n', 'utf8');
  fs.writeFileSync(path.join(root, 'note.txt'), 'hello', 'utf8');
  const registry = new ToolRegistry().registerMany(createBuiltinTools({ sandbox: null }));

  for (const name of ['data.profile', 'data.analyze', 'data.createChartArtifact', 'file.plan-organize']) {
    const schema = registry.descriptor(name)?.inputSchema as { additionalProperties?: unknown } | undefined;
    assert.equal(schema?.additionalProperties, false, `${name} schema must be closed`);
  }
  const plan = agentTool('PlanFileOrganization', root);
  assert.equal((plan.parameters as { additionalProperties?: unknown }).additionalProperties, false);

  const profile = await registry.call('data.profile', { path: 'sales.csv', maxRows: 10 }, {
    trustedRoot: root,
    context: ALICE,
  }) as { rowCount?: unknown };
  assert.equal(profile.rowCount, 1);
  const organized = await registry.call('file.plan-organize', {
    files: ['note.txt'],
    mode: 'rename',
    renamePrefix: 'safe',
  }, { trustedRoot: root, context: ALICE }) as { operations?: unknown[] };
  assert.equal(Array.isArray(organized.operations), true);
});

test('actual agent loop rejects PlanFileOrganization trustedRoot before its handler', async () => {
  const root = workspace('agent-server');
  const attackerRoot = workspace('agent-attacker');
  fs.writeFileSync(path.join(attackerRoot, 'bob.txt'), 'BOB_ONLY', 'utf8');
  let calls = 0;
  let validationMessage: ChatMessage | undefined;
  const modelCall: ModelCall = async (args) => {
    calls += 1;
    if (calls === 1) {
      return {
        content: '',
        tool_calls: [{
          id: 'plan_1',
          function: {
            name: 'PlanFileOrganization',
            arguments: JSON.stringify({ files: ['bob.txt'], mode: 'rename', trustedRoot: attackerRoot }),
          },
        }],
      };
    }
    validationMessage = Array.isArray(args.messages) ? args.messages.at(-1) : undefined;
    return { content: 'rejected' };
  };

  const outcome = await runAgentChat({
    prompt: 'organize files',
    kimiConfig: TEST_LOCAL_MODEL_CONFIG,
    trustedRoot: root,
    tools: createAgentTools({ trustedRoot: root, context: ALICE }),
    modelCall,
    runStoreRoot: path.join(root, 'runs'),
  });

  assert.equal(outcome.text, 'rejected');
  assert.equal(outcome.steps[0]?.invalidArgs, true);
  const content = String((validationMessage as { content?: unknown } | undefined)?.content || '');
  assert.match(content, /invalid tool arguments/i);
  assert.match(content, /trustedRoot/);
  assert.doesNotMatch(content, new RegExp(attackerRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('native data tools close schemas and reject root overrides and unknown fields', async () => {
  const root = workspace('native-data-server');
  const attackerRoot = workspace('native-data-attacker');
  fs.writeFileSync(path.join(root, 'sales.csv'), 'name,value\nALICE_ONLY,1\n', 'utf8');
  fs.writeFileSync(path.join(attackerRoot, 'sales.csv'), 'name,value\nBOB_ONLY,2\n', 'utf8');
  const analyze = agentTool('AnalyzeDataFile', root);
  const chart = agentTool('CreateDataChartArtifact', root);

  assert.equal((analyze.parameters as { additionalProperties?: unknown }).additionalProperties, false);
  assert.equal((chart.parameters as { additionalProperties?: unknown }).additionalProperties, false);
  await assert.rejects(
    () => Promise.resolve(analyze.handler({ path: 'sales.csv', trustedRoot: attackerRoot })),
    isBadInput,
  );
  await assert.rejects(
    () => Promise.resolve(chart.handler({ path: 'sales.csv', id: 'unknown_chart', extra: true })),
    isBadInput,
  );
});

test('native data tool projection never invokes argument getters or proxy traps', async () => {
  const root = workspace('native-data-objects');
  fs.writeFileSync(path.join(root, 'sales.csv'), 'name,value\na,1\n', 'utf8');
  const analyze = agentTool('AnalyzeDataFile', root);
  let getterRuns = 0;
  const accessorArgs = Object.defineProperty({}, 'path', {
    enumerable: true,
    get() {
      getterRuns += 1;
      return 'sales.csv';
    },
  });
  await assert.rejects(
    () => Promise.resolve(analyze.handler(accessorArgs)),
    isBadInput,
  );
  assert.equal(getterRuns, 0);

  const proxyTrapRuns = { getPrototypeOf: 0, ownKeys: 0, getOwnPropertyDescriptor: 0, get: 0 };
  const hostileProxy = new Proxy({ path: 'sales.csv' }, {
    getPrototypeOf(target) {
      proxyTrapRuns.getPrototypeOf += 1;
      return Reflect.getPrototypeOf(target);
    },
    ownKeys(target) {
      proxyTrapRuns.ownKeys += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      proxyTrapRuns.getOwnPropertyDescriptor += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) {
      proxyTrapRuns.get += 1;
      return Reflect.get(target, key, receiver);
    },
  });
  await assert.rejects(() => Promise.resolve(analyze.handler(hostileProxy)), isBadInput);
  assert.deepEqual(proxyTrapRuns, {
    getPrototypeOf: 0,
    ownKeys: 0,
    getOwnPropertyDescriptor: 0,
    get: 0,
  });
});
