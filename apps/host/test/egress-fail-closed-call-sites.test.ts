import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAgentTools } from '../src/kimi/agent-tools.js';
import { callModelResilient } from '../src/kimi/agent/model-resilience.js';
import { createDefaultAgentRegistry } from '../src/orchestrator/agent-registry.js';
import { createProviderTaskRunner } from '../src/orchestrator/provider-task-runner.js';
import { extractMeetingActions } from '../src/recipes/model-recipe.js';
import { readEgressAuditRecords } from '../src/security/egress-audit.js';
import { isEgressAuditFailure } from '../src/security/egress-gateway.js';
import { createWebBuiltinTools } from '../src/tools/web-builtin-tools.js';
import { agentTool } from './helpers/agent.js';
import type { AgentTask, ContextPack } from '../src/orchestrator/types.js';
import type { WebFetchLike } from '../src/tools/web-fetch.js';

function blockedAuditRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-blocked-'));
  fs.writeFileSync(path.join(root, '.AgentCowork'), 'not a directory', 'utf8');
  return root;
}

function isAuditFailure(error: unknown): boolean {
  return isEgressAuditFailure(error);
}

function providerInputs(): {
  task: AgentTask;
  pack: ContextPack;
  agent: ReturnType<ReturnType<typeof createDefaultAgentRegistry>['get']>;
} {
  const agent = createDefaultAgentRegistry().get('writer');
  const task: AgentTask = {
    taskId: 'task_audit_fail_closed',
    runId: 'run_audit_fail_closed',
    parentTaskId: '',
    agentId: 'writer',
    title: 'Summarize evidence',
    instruction: 'Summarize without inventing facts.',
    inputRefs: [],
    expectedOutput: 'Grounded summary.',
    outputSchemaName: agent.outputSchema.name,
    priority: 'normal',
    dependencies: [],
    timeoutMs: agent.budget.maxRuntimeMs,
    budget: agent.budget,
    approvalPolicy: 'never',
  };
  const pack: ContextPack = {
    contextPackId: 'ctx_audit_fail_closed',
    agentId: 'writer',
    taskId: task.taskId,
    userGoalSummary: 'Verify fail-closed egress',
    entries: [],
    forbidden: [],
    redactionReport: { mode: 'secrets_only', redactedCount: 0, omittedRefs: 0, truncatedRefs: 0 },
  };
  return { task, pack, agent };
}

test('model resilience never invokes a local endpoint when audit persistence fails', async () => {
  const trustedRoot = blockedAuditRoot();
  let modelCalls = 0;
  await assert.rejects(
    () => callModelResilient(
      async () => {
        modelCalls += 1;
        return { content: 'must not run' };
      },
      { trustedRoot },
      {
        kimiConfig: {
          provider: 'openai/local',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'local-model',
          securityMode: 'local_strict',
        },
      },
    ),
    isAuditFailure,
  );
  assert.equal(modelCalls, 0);
});

test('audit failures stay outside the model circuit breaker', async () => {
  const trustedRoot = blockedAuditRoot();
  const config = {
    provider: 'openai/local',
    baseUrl: 'http://127.0.0.1:11435/v1',
    model: 'audit-breaker-model',
    securityMode: 'local_strict',
  };
  let modelCalls = 0;
  const modelCall = async () => {
    modelCalls += 1;
    return { content: 'ok' };
  };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await assert.rejects(
      () => callModelResilient(modelCall, { trustedRoot }, { kimiConfig: config }),
      isAuditFailure,
    );
  }
  fs.unlinkSync(path.join(trustedRoot, '.AgentCowork'));
  const result = await callModelResilient(modelCall, { trustedRoot }, { kimiConfig: config });
  assert.equal((result as { content?: unknown }).content, 'ok');
  assert.equal(modelCalls, 1);
});

test('filtered denied model candidates are audited before a local fallback runs', async () => {
  const trustedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-filtered-'));
  const seenProviders: unknown[] = [];
  const result = await callModelResilient(
    async ({ kimiConfig }) => {
      seenProviders.push(kimiConfig.provider);
      return { content: 'local fallback' };
    },
    { trustedRoot },
    {
      kimiConfig: {
        securityMode: 'local_strict',
        provider: 'kimi-api',
        baseUrl: 'https://api.moonshot.ai/v1',
        model: 'denied-cloud',
        fallbacks: [{
          provider: 'openai/local',
          baseUrl: 'http://127.0.0.1:11434/v1',
          model: 'allowed-local',
        }],
      },
    },
  );
  assert.equal((result as { content?: unknown }).content, 'local fallback');
  assert.deepEqual(seenProviders, ['openai/local']);
  assert.deepEqual(
    readEgressAuditRecords(trustedRoot).map((record) => [record.provider, record.decision]),
    [['kimi-api', 'deny'], ['openai/local', 'allow']],
  );
});

test('AI recipe extraction propagates audit failure before its model fallback layer', async () => {
  const trustedRoot = blockedAuditRoot();
  let modelCalls = 0;
  await assert.rejects(
    () => extractMeetingActions({
      source: '张三负责联调。',
      trustedRoot,
      modelConfig: {
        provider: 'openai/local',
        baseUrl: 'http://127.0.0.1:11434/v1',
        model: 'local-model',
        securityMode: 'local_strict',
      },
      modelCall: (async () => {
        modelCalls += 1;
        return { content: '[]' };
      }) as never,
    }),
    isAuditFailure,
  );
  assert.equal(modelCalls, 0);
});

test('provider task runner never invokes the provider when audit persistence fails', async () => {
  const trustedRoot = blockedAuditRoot();
  const { task, pack, agent } = providerInputs();
  let modelCalls = 0;
  const runner = createProviderTaskRunner({
    trustedRoot,
    modelConfig: {
      provider: 'openai/local',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'local-model',
      securityMode: 'local_strict',
    },
    modelCall: async () => {
      modelCalls += 1;
      return { content: 'must not run' };
    },
  });

  await assert.rejects(() => runner(task, pack, agent), isAuditFailure);
  assert.equal(modelCalls, 0);
});

test('both WebFetch surfaces preserve policy denial and attach audit failure without fetching', async () => {
  const trustedRoot = blockedAuditRoot();
  let fetchCalls = 0;
  const fetchImpl: WebFetchLike = async () => {
    fetchCalls += 1;
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'text/plain' },
      arrayBuffer: () => new ArrayBuffer(0),
    };
  };
  const builtin = createWebBuiltinTools({
    fetchImpl,
    resolveSecurityMode: () => 'local_strict',
  }).find((tool) => tool.name === 'web.fetch');
  assert.ok(builtin);
  await assert.rejects(
    () => builtin.handler({ url: 'https://example.com' }, { trustedRoot }),
    (error: unknown) => (error as { code?: unknown }).code === 'EGRESS_POLICY_DENIED'
      && isAuditFailure(error),
  );

  const native = agentTool(createAgentTools({
    trustedRoot,
    context: { securityMode: 'local_strict' },
    fetchImpl,
  }), 'WebFetch');
  await assert.rejects(
    () => native.handler({ url: 'https://example.com' }),
    (error: unknown) => (error as { code?: unknown }).code === 'EGRESS_POLICY_DENIED'
      && isAuditFailure(error),
  );
  assert.equal(fetchCalls, 0);
});
