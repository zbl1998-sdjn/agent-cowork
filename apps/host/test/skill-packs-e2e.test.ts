import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createServer } from '../src/server.js';
import { noopKimiChatRunner, postAgentStream, readAgentStream } from './helpers/agent-stream.js';
import { bind, close, tempRoot } from './helpers/host-http.js';
import { TEST_LOCAL_HOST_MODEL_CONFIG } from './helpers/kimi-config.js';

const SKILL_BODY_MARKER = '先读上周记录,再写三段式周报。';

function writeWeeklyReportPack(root: string): void {
  const dir = path.join(root, '.AgentCowork', 'skills', 'weekly-report');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), [
    '---',
    'name: weekly-report',
    'description: 汇总本周产出写周报。写周报时使用。',
    '---',
    '',
    `# 周报技能\n${SKILL_BODY_MARKER}`,
  ].join('\n'), 'utf8');
}

async function J(base: string, route: string, opt: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${route}`, {
    method: opt.method || 'GET',
    headers: { 'content-type': 'application/json' },
    ...(opt.body === undefined ? {} : { body: JSON.stringify(opt.body) }),
  });
  const body = await res.json() as Record<string, unknown>;
  return { status: res.status, body };
}

test('E2E skill packs: catalog is injected and LoadSkill feeds untrusted-wrapped instructions back', async () => {
  const root = tempRoot('acw-skillpack-');
  writeWeeklyReportPack(root);
  const modelInputs: string[] = [];
  let n = 0;
  const agentModelCall = async (...args: unknown[]) => {
    modelInputs.push(JSON.stringify(args));
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'LoadSkill', arguments: JSON.stringify({ name: 'weekly-report' }) } }] };
    return { content: '已按技能包指令完成周报。' };
  };
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const res = await postAgentStream(base, { prompt: '写周报', autoApprove: true });
    assert.equal(res.status, 200);
    const all = await readAgentStream(res);
    assert.match(all, /event: done/);
    assert.match(all, /已按技能包指令完成周报/);

    assert.ok(modelInputs[0], 'first model call captured');
    assert.match(modelInputs[0], /可用技能包/);
    assert.match(modelInputs[0], /weekly-report/);
    assert.match(modelInputs[0], /汇总本周产出写周报/);

    assert.ok(modelInputs[1], 'second model call captured');
    assert.ok(modelInputs[1].includes(SKILL_BODY_MARKER), 'LoadSkill result fed back to the model');
    assert.match(modelInputs[1], /BEGIN_UNTRUSTED_DATA/);
  } finally {
    await close(server);
  }
});

test('E2E skill packs: /api/skill-packs lists, toggling persists, and disabled packs vanish from the loop', async () => {
  const root = tempRoot('acw-skillpack-');
  writeWeeklyReportPack(root);
  const modelInputs: string[] = [];
  let n = 0;
  const agentModelCall = async (...args: unknown[]) => {
    modelInputs.push(JSON.stringify(args));
    n += 1;
    if (n === 1) return { content: '', tool_calls: [{ id: 'c1', function: { name: 'LoadSkill', arguments: JSON.stringify({ name: 'weekly-report' }) } }] };
    return { content: '结束。' };
  };
  const server = createServer({ ...TEST_LOCAL_HOST_MODEL_CONFIG, requireAuth: false, trustedRoot: root, enableScheduler: false, modelChatRunner: noopKimiChatRunner, agentModelCall });
  const base = await bind(server);
  try {
    const list = await J(base, '/api/skill-packs');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.packs, [{ name: 'weekly-report', description: '汇总本周产出写周报。写周报时使用。', enabled: true }]);
    assert.deepEqual(list.body.warnings, []);

    const off = await J(base, '/api/skill-packs/weekly-report/toggle', { method: 'POST', body: { enabled: false } });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    const settingsFile = path.join(root, '.AgentCowork', 'settings', 'skill-packs.json');
    assert.match(fs.readFileSync(settingsFile, 'utf8'), /weekly-report/);

    const after = await J(base, '/api/skill-packs');
    const packs = after.body.packs as Array<{ name: string; enabled: boolean }>;
    assert.equal(packs[0]?.enabled, false);

    const res = await postAgentStream(base, { prompt: '写周报', autoApprove: true });
    const all = await readAgentStream(res);
    assert.match(all, /event: done/);
    assert.ok(modelInputs[0], 'model call captured');
    assert.doesNotMatch(modelInputs[0], /可用技能包/);
    assert.ok(!modelInputs[0].includes('LoadSkill'), 'disabled packs mount no LoadSkill tool');

    const bad = await J(base, '/api/skill-packs/bad--name/toggle', { method: 'POST', body: { enabled: false } });
    assert.equal(bad.status, 400);
  } finally {
    await close(server);
  }
});
