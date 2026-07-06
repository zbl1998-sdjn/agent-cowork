// 数据销毁 + 保留期(切片 2d)——计划先行、路径 jail、confirm 门控
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  buildPurgePlan,
  executePurgePlan,
  applyRetention,
  PURGE_SCOPES,
} from '../src/security/data-purge.js';

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-purge-'));
  const A = path.join(root, '.AgentCowork');
  for (const rel of ['conversations/t/u', 'runs/checkpoints', 'memory', 'index', 'security']) {
    fs.mkdirSync(path.join(A, rel), { recursive: true });
  }
  fs.writeFileSync(path.join(A, 'conversations/t/u/c1.json'), '{"id":"c1"}');
  fs.writeFileSync(path.join(A, 'runs/run_1.json'), '{"id":"run_1"}');
  fs.writeFileSync(path.join(A, 'runs/checkpoints/run_1.json'), '{}');
  fs.writeFileSync(path.join(A, 'memory/MEMORY.md'), '# mem');
  fs.writeFileSync(path.join(A, 'security/at-rest.key'), 'aesgcm:v1:...');
  fs.writeFileSync(path.join(A, 'config.json'), '{}');
  return root;
}

test('scopes are well-defined and content scope excludes keys/config', () => {
  assert.deepEqual(PURGE_SCOPES, ['conversations', 'runs', 'memory', 'content', 'everything']);
  const root = workspace();
  const plan = buildPurgePlan(root, { scope: 'content' });
  const rels = plan.targets.map((t) => t.rel).sort();
  assert.ok(rels.includes('conversations') && rels.includes('runs') && rels.includes('memory'));
  assert.ok(!rels.includes('security'), 'content scope must keep the key store');
  assert.ok(!rels.some((r) => r.includes('config.json')), 'content scope must keep config');
  assert.equal(plan.executed, false, 'buildPurgePlan never touches disk');
});

test('everything scope targets the whole .AgentCowork (true wipe incl. keys)', () => {
  const root = workspace();
  const plan = buildPurgePlan(root, { scope: 'everything' });
  assert.deepEqual(plan.targets.map((t) => t.rel), ['.AgentCowork']);
});

test('buildPurgePlan is jailed: targets never escape .AgentCowork', () => {
  const root = workspace();
  for (const scope of PURGE_SCOPES) {
    for (const t of buildPurgePlan(root, { scope }).targets) {
      const resolved = path.resolve(t.path);
      const jail = path.resolve(root, '.AgentCowork');
      assert.ok(resolved === jail || resolved.startsWith(jail + path.sep), `${t.path} escaped jail`);
    }
  }
});

test('executePurgePlan requires confirm and only deletes jailed targets', () => {
  const root = workspace();
  const plan = buildPurgePlan(root, { scope: 'conversations' });
  // 不确认 → 不删
  const dry = executePurgePlan(plan, { confirm: false });
  assert.equal(dry.removed.length, 0);
  assert.ok(fs.existsSync(path.join(root, '.AgentCowork', 'conversations')));
  // 确认 → 删对话,保留 runs/memory/security
  const done = executePurgePlan(plan, { confirm: true });
  assert.ok(done.removed.length >= 1);
  assert.ok(!fs.existsSync(path.join(root, '.AgentCowork', 'conversations')));
  assert.ok(fs.existsSync(path.join(root, '.AgentCowork', 'runs')), 'runs kept');
  assert.ok(fs.existsSync(path.join(root, '.AgentCowork', 'security')), 'key store kept');
});

test('executePurgePlan refuses a tampered plan whose target escaped the jail', () => {
  const root = workspace();
  const plan = buildPurgePlan(root, { scope: 'conversations' });
  const outside = path.join(os.tmpdir(), 'kcw-should-not-delete');
  fs.mkdirSync(outside, { recursive: true });
  const tampered = { ...plan, targets: [{ rel: 'evil', path: outside, bytes: 0 }] };
  assert.throws(() => executePurgePlan(tampered, { confirm: true }), /jail/i);
  assert.ok(fs.existsSync(outside), 'out-of-jail path must not be deleted');
  fs.rmSync(outside, { recursive: true, force: true });
});

test('applyRetention removes run records + conversations older than maxAgeDays', () => {
  const root = workspace();
  const A = path.join(root, '.AgentCowork');
  const oldTime = new Date('2026-01-01T00:00:00Z');
  const oldRun = path.join(A, 'runs', 'run_old.json');
  fs.writeFileSync(oldRun, '{"id":"run_old"}');
  const utimes = (fs as unknown as { utimesSync: (p: string, a: Date, m: Date) => void }).utimesSync;
  utimes(oldRun, oldTime, oldTime);
  utimes(path.join(A, 'conversations/t/u/c1.json'), oldTime, oldTime);

  const now = new Date('2026-07-07T00:00:00Z');
  const result = applyRetention(root, { maxAgeDays: 30, now });
  assert.ok(!fs.existsSync(oldRun), 'old run purged');
  assert.ok(!fs.existsSync(path.join(A, 'conversations/t/u/c1.json')), 'old conversation purged');
  assert.ok(fs.existsSync(path.join(A, 'runs', 'run_1.json')), 'fresh run kept');
  assert.ok(result.removed.length >= 2);
});
