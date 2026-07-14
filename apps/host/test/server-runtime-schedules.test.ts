import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { createSkillRegistry } from '../src/skills/skill-registry.js';
import { FileScheduleStore, type ScheduleStore } from '../src/runtime/scheduler.js';
import {
  arrayField,
  bind,
  close,
  jsonRequest,
  objectField,
  present,
  recordValue,
  stringField,
  tempRoot,
} from './helpers/host-http.js';

function fileScheduleStore(trustedRoot: string): FileScheduleStore {
  return new FileScheduleStore({
    storeDir: path.join(trustedRoot, '.AgentCowork', 'schedules'),
  });
}

test('schedules: create cron + list + cancel + manual tick', async () => {
  const trustedRoot = tempRoot();
  const fired: string[] = [];
  const server = createServer({
    trustedRoot,
    scheduleStore: fileScheduleStore(trustedRoot),
    enableScheduler: true,
    startScheduler: false,
    scheduleExecutor: async (record) => {
      fired.push(record.id);
      return { runId: `run_for_${record.id}` };
    },
  });
  const base = await bind(server);
  try {
    const listEmpty = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
    });
    assert.equal(listEmpty.status, 200);
    assert.equal(listEmpty.body.enabled, true);
    assert.equal(arrayField(listEmpty.body, 'schedules', 'empty schedule list').length, 0);

    const createCron = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sched-weekly' },
      body: { name: 'weekly', cron: '* * * * *', payload: { recipeId: 'meeting-actions' } },
    });
    assert.equal(createCron.status, 200);
    const createCronSchedule = objectField(createCron.body, 'schedule', 'created cron schedule');
    const scheduleId = stringField(createCronSchedule, 'id', 'created cron schedule id');
    assert.match(scheduleId, /^sched_/);
    assert.equal(createCronSchedule.tenantId, 'tenant_alice');

    const listOne = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
    });
    const schedules = arrayField(listOne.body, 'schedules', 'one schedule list');
    const firstSchedule = present(schedules[0], 'first listed schedule');
    assert.equal(schedules.length, 1);
    assert.equal(firstSchedule.name, 'weekly');
    assert.deepEqual(firstSchedule.attempts, []);

    const file = path.join(trustedRoot, '.AgentCowork', 'schedules', `${scheduleId}.json`);
    const raw = recordValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'schedule file');
    raw.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const tick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sched-weekly-tick' },
    });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.fired, 1);
    assert.equal(fired.length, 1);

    const afterTick = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
    });
    const firedSchedule = present(arrayField(afterTick.body, 'schedules', 'schedules after tick')[0], 'fired schedule');
    const attempts = arrayField(firedSchedule, 'attempts', 'schedule attempt history');
    const latestAttempt = present(attempts[0], 'latest schedule attempt');
    assert.match(String(latestAttempt.attemptId), /^attempt_/);
    assert.equal(latestAttempt.status, 'succeeded');
    assert.equal(latestAttempt.runId, `run_for_${scheduleId}`);
    assert.equal(latestAttempt.error, null);
    assert.equal(latestAttempt.trigger, 'scheduled');

    const cancel = await jsonRequest(base, `/api/schedules/${scheduleId}/cancel`, {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sched-weekly-cancel' },
    });
    assert.equal(cancel.status, 200);
    assert.equal(objectField(cancel.body, 'schedule', 'cancelled schedule').status, 'cancelled');

    const remove = await jsonRequest(base, `/api/schedules/${scheduleId}`, {
      method: 'DELETE',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sched-weekly-remove' },
    });
    assert.equal(remove.status, 200);
    const afterRemove = await jsonRequest(base, '/api/schedules', {
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
    });
    assert.equal(arrayField(afterRemove.body, 'schedules', 'schedules after remove').length, 0);
  } finally {
    await close(server);
  }
});

test('schedules: default executor forwards configured model to runRecipe (functional completeness: scheduled recipes must be able to use the AI path, not always fall back to the template)', async () => {
  const trustedRoot = tempRoot();
  const notesPath = path.join(trustedRoot, 'notes.txt');
  fs.writeFileSync(notesPath, '张三负责登录模块联调,截止下周三。', 'utf8');
  // 不传 scheduleExecutor:走 host-scheduler.ts 的 defaultScheduleExecutor,验证它真的把
  // state.agentModelConfig 转发给了 runRecipe(此前从不转发,定时任务永远只能走模板路径)。
  const server = createServer({
    trustedRoot,
    scheduleStore: fileScheduleStore(trustedRoot),
    enableScheduler: true,
    startScheduler: false,
    modelProvider: 'ollama',
    // 端口 1 通常无人监听:立即 ECONNREFUSED,不用等 AI_MODEL_TIMEOUT_MS 超时——
    // 本测试只验证 modelConfig 被转发、AI 路径被尝试,不验证真实模型响应。
    modelBaseUrl: 'http://127.0.0.1:1/v1',
    model: 'kimi-k2.7-code',
  });
  const base = await bind(server);
  try {
    const created = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'idempotency-key': 'sched-ai-forward' },
      body: { name: 'ai-forward', cron: '* * * * *', payload: { recipeId: 'meeting-actions', files: [notesPath] } },
    });
    assert.equal(created.status, 200);
    const scheduleId = stringField(objectField(created.body, 'schedule', 'created schedule'), 'id', 'schedule id');

    const file = path.join(trustedRoot, '.AgentCowork', 'schedules', `${scheduleId}.json`);
    const raw = recordValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'schedule file');
    raw.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const tick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'idempotency-key': 'sched-ai-forward-tick' },
    });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.fired, 1);

    // 无法连接的 baseUrl 会让 AI 提取超时/失败并回退模板(这是预期的优雅降级,不是本测试要
    // 验证的点)。真正要验证的是:defaultScheduleExecutor 确实尝试过 AI 路径而不是直接跳过——
    // run 记录的 events 里应出现 AI 提取相关的 progress 文案。
    const runsDir = path.join(trustedRoot, '.AgentCowork', 'runs');
    const runFiles = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json'));
    assert.ok(runFiles.length >= 1, 'run record should be written');
    const runFile = runFiles[0];
    assert.ok(runFile);
    const runRecord = recordValue(JSON.parse(fs.readFileSync(path.join(runsDir, runFile), 'utf8')) as unknown, 'run record');
    const events = Array.isArray(runRecord.events) ? runRecord.events : [];
    const sawAiAttempt = events.some((e) => {
      const ev = recordValue(e, 'event');
      return typeof ev.text === 'string' && ev.text.includes('AI 正在从来源提取');
    });
    assert.equal(sawAiAttempt, true, 'defaultScheduleExecutor 必须转发 modelConfig 让 AI 路径被尝试,不能永远跳过');
  } finally {
    await close(server);
  }
});

test('schedules: one-shot fireAt creates schedule', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: true,
    startScheduler: false,
    scheduleExecutor: async () => ({ runId: 'r1' }),
  });
  const base = await bind(server);
  try {
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const created = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'idempotency-key': 'sched-once' },
      body: { name: 'once', fireAt, payload: {} },
    });
    assert.equal(created.status, 200);
    const createdSchedule = objectField(created.body, 'schedule', 'created one-shot schedule');
    assert.equal(createdSchedule.kind, 'one-shot');
    assert.equal(createdSchedule.nextFireAt, fireAt);
  } finally {
    await close(server);
  }
});

test('default schedules route rejects prompt-only, unknown, and disabled recipes before persisting', async () => {
  const trustedRoot = tempRoot();
  let saveCalls = 0;
  const scheduleStore: ScheduleStore = {
    list: () => [],
    get: () => null,
    save: (record) => {
      saveCalls += 1;
      return record;
    },
    remove: () => false,
  };
  const skillRegistry = createSkillRegistry({ initialDisabled: ['meeting-actions'] });
  const server = createServer({
    trustedRoot,
    enableScheduler: true,
    startScheduler: false,
    scheduleStore,
    skillRegistry,
  });
  const base = await bind(server);
  try {
    const cases = [
      {
        key: 'sched-missing-recipe',
        payload: { prompt: '只有提示词' },
        code: 'RECIPE_REQUIRED',
      },
      {
        key: 'sched-unknown-recipe',
        payload: { recipeId: 'not-installed' },
        code: 'RECIPE_UNAVAILABLE',
      },
      {
        key: 'sched-disabled-recipe',
        payload: { recipeId: 'meeting-actions' },
        code: 'RECIPE_UNAVAILABLE',
      },
    ] as const;

    for (const item of cases) {
      const response = await jsonRequest(base, '/api/schedules', {
        method: 'POST',
        headers: { 'idempotency-key': item.key },
        body: { name: item.key, cron: '* * * * *', payload: item.payload },
      });
      assert.equal(response.status, 400);
      assert.equal(response.body.code, item.code);
    }
    assert.equal(saveCalls, 0, 'invalid default recipe schedules must not reach scheduler.create/store.save');
  } finally {
    await close(server);
  }
});

test('default scheduler revalidates recipe enabled state immediately before firing', async () => {
  const trustedRoot = tempRoot();
  const sourcePath = path.join(trustedRoot, 'meeting-notes.md');
  fs.writeFileSync(sourcePath, '# 会议纪要\n- 跟进采购合同\n', 'utf8');
  const skillRegistry = createSkillRegistry();
  const server = createServer({
    trustedRoot,
    scheduleStore: fileScheduleStore(trustedRoot),
    enableScheduler: true,
    startScheduler: false,
    skillRegistry,
  });
  const base = await bind(server);
  try {
    const created = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_alice',
        'x-user-id': 'user_alice',
        'idempotency-key': 'sched-disable-after-create',
      },
      body: {
        name: '禁用前创建',
        fireAt: new Date(Date.now() + 60_000).toISOString(),
        payload: { recipeId: 'meeting-actions', files: [sourcePath] },
      },
    });
    assert.equal(created.status, 200);
    const scheduleId = stringField(objectField(created.body, 'schedule', 'created schedule'), 'id', 'schedule id');

    skillRegistry.setEnabled('meeting-actions', false);
    const file = path.join(trustedRoot, '.AgentCowork', 'schedules', `${scheduleId}.json`);
    const raw = recordValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'schedule file');
    raw.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const tick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: {
        'x-tenant-id': 'tenant_alice',
        'x-user-id': 'user_alice',
        'idempotency-key': 'sched-disable-before-tick',
      },
    });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.fired, 1);
    const tickResult = present(arrayField(tick.body, 'results', 'tick results')[0], 'tick result');
    assert.equal(tickResult.ok, false);

    const failed = recordValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'failed schedule');
    assert.equal(failed.status, 'failed');
    assert.match(String(failed.lastError), /recipe.*not available|配方.*不可用/i);
    const attempts = arrayField(failed, 'attempts', 'failed schedule attempts');
    const latestAttempt = present(attempts[0], 'failed schedule attempt');
    assert.equal(latestAttempt.status, 'failed');
    assert.equal(latestAttempt.runId, null);
    assert.match(String(latestAttempt.error), /recipe.*not available|配方.*不可用/i);
    assert.equal(latestAttempt.trigger, 'scheduled');
    const index = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
    });
    assert.equal(arrayField(index.body, 'runs', 'runs after disabled recipe tick').length, 0);
  } finally {
    await close(server);
  }
});

test('schedules disabled returns 503 when enableScheduler:false', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const create = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      body: { name: 'noop', cron: '* * * * *' },
    });
    assert.equal(create.status, 503);
    assert.match(String(create.body.error), /Scheduler is not enabled/);
  } finally {
    await close(server);
  }
});

test('schedules reject malformed create bodies', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    enableScheduler: true,
    startScheduler: false,
    scheduleExecutor: async () => ({ runId: 'r1' }),
  });
  const base = await bind(server);
  try {
    const badName = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'idempotency-key': 'sched-bad-name' },
      body: { name: '', cron: '* * * * *', payload: {} },
    });
    assert.equal(badName.status, 400);

    const badPayload = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'idempotency-key': 'sched-bad-payload' },
      body: { name: 'bad payload', cron: '* * * * *', payload: 'not-an-object' },
    });
    assert.equal(badPayload.status, 400);
  } finally {
    await close(server);
  }
});

test('scheduler default executor runs a recipe and records a run', async () => {
  const trustedRoot = tempRoot();
  const server = createServer({
    trustedRoot,
    scheduleStore: fileScheduleStore(trustedRoot),
    enableScheduler: true,
    startScheduler: false,
  });
  const base = await bind(server);
  try {
    // meeting-actions 配方现在要求可用来源:给计划任务也铺好会议纪要并显式传入。
    const sourcePath = path.join(trustedRoot, 'meeting-notes.md');
    fs.writeFileSync(sourcePath, '# 会议纪要\n- 跟进采购合同\n', 'utf8');
    const fireAt = new Date(Date.now() + 60_000).toISOString();
    const created = await jsonRequest(base, '/api/schedules', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sched-default-executor' },
      body: {
        name: '每周会议纪要',
        fireAt,
        payload: { recipeId: 'meeting-actions', prompt: '自动整理', files: [sourcePath] },
      },
    });
    assert.equal(created.status, 200);
    const defaultSchedule = objectField(created.body, 'schedule', 'default executor schedule');
    const scheduleId = stringField(defaultSchedule, 'id', 'default executor schedule id');

    const file = path.join(trustedRoot, '.AgentCowork', 'schedules', `${scheduleId}.json`);
    const raw = recordValue(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown, 'schedule file');
    raw.nextFireAt = new Date(Date.now() - 60_000).toISOString();
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf8');

    const tick = await jsonRequest(base, '/api/schedules/_tick', {
      method: 'POST',
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice', 'idempotency-key': 'sched-default-tick' },
    });
    assert.equal(tick.status, 200);
    assert.equal(tick.body.fired, 1);
    const firstTickResult = present(arrayField(tick.body, 'results', 'default executor tick results')[0], 'first tick result');
    assert.ok(firstTickResult.runId, 'executor produced a runId');

    const index = await jsonRequest(base, '/api/runs/index', {
      headers: { 'x-tenant-id': 'tenant_alice', 'x-user-id': 'user_alice' },
    });
    const indexedRuns = arrayField(index.body, 'runs', 'default executor indexed runs');
    const indexedScheduledRun = present(indexedRuns[0], 'first scheduled run');
    assert.equal(indexedRuns.length, 1);
    assert.equal(indexedScheduledRun.recipeId, 'meeting-actions');
    assert.equal(indexedScheduledRun.status, 'awaiting_approval');
  } finally {
    await close(server);
  }
});
