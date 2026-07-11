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

type SymlinkSync = (
  target: string,
  linkPath: string,
  type?: 'file' | 'dir' | 'junction',
) => void;

const symlinkSync = (fs as unknown as { symlinkSync: SymlinkSync }).symlinkSync;

function linkDirectory(target: string, linkPath: string): void {
  try {
    symlinkSync(target, linkPath, 'junction');
  } catch {
    symlinkSync(target, linkPath, 'dir');
  }
}

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

test('executePurgePlan derives its jail from trustedRoot instead of a tampered appDir', () => {
  const root = workspace();
  const plan = buildPurgePlan(root, { scope: 'conversations' });
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-purge-tampered-app-'));
  const outsideTarget = path.join(outside, 'conversations');
  const sentinel = path.join(outsideTarget, 'must-survive.json');
  fs.mkdirSync(outsideTarget, { recursive: true });
  fs.writeFileSync(sentinel, '{"outside":true}', 'utf8');

  const tampered = {
    ...plan,
    appDir: outside,
    targets: [{ rel: 'conversations', path: outsideTarget, bytes: 1 }],
  };
  assert.throws(
    () => executePurgePlan(tampered, { confirm: true }),
    /jail|appDir|trustedRoot/i,
  );
  assert.equal(fs.existsSync(sentinel), true, 'tampered appDir must not authorize outside deletion');
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

test('applyRetention rejects a junction and never deletes its outside target', (t) => {
  const root = workspace();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-retention-outside-'));
  const outsideFile = path.join(outside, 'old.json');
  const oldTime = new Date('2026-01-01T00:00:00Z');
  fs.writeFileSync(outsideFile, '{"outside":true}', 'utf8');
  fs.utimesSync(outsideFile, oldTime, oldTime);
  const link = path.join(root, '.AgentCowork', 'runs', 'escaped');
  try {
    linkDirectory(outside, link);
  } catch (error) {
    t.skip(`symlink/junction unavailable: ${String(error)}`);
    return;
  }

  assert.throws(
    () => applyRetention(root, { maxAgeDays: 30, now: new Date('2026-07-07T00:00:00Z') }),
    /symbolic link|junction|reparse|escaped jail/i,
  );
  assert.equal(fs.existsSync(outsideFile), true, 'retention must not follow a link outside the workspace');
});

test('applyRetention revalidates a directory after listing before deleting a child', (t) => {
  const root = workspace();
  const runsRoot = path.join(root, '.AgentCowork', 'runs');
  const ownerDir = path.join(runsRoot, 'owner-swap');
  const displacedOwnerDir = path.join(runsRoot, 'owner-swap-original');
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-retention-swap-outside-'));
  const outsideFile = path.join(outside, 'old.json');
  const oldTime = new Date('2026-01-01T00:00:00Z');
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(path.join(ownerDir, 'old.json'), '{"inside":true}', 'utf8');
  fs.writeFileSync(outsideFile, '{"outside":true}', 'utf8');
  fs.utimesSync(path.join(ownerDir, 'old.json'), oldTime, oldTime);
  fs.utimesSync(outsideFile, oldTime, oldTime);

  const originalReaddirSync = fs.readdirSync;
  let swapped = false;
  fs.readdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalReaddirSync, fs, args);
    if (!swapped && path.resolve(String(args[0])) === path.resolve(ownerDir)) {
      fs.renameSync(ownerDir, displacedOwnerDir);
      try {
        linkDirectory(outside, ownerDir);
      } catch (error) {
        fs.renameSync(displacedOwnerDir, ownerDir);
        t.skip(`symlink/junction unavailable: ${String(error)}`);
      }
      swapped = true;
    }
    return result;
  }) as typeof fs.readdirSync;

  try {
    assert.throws(
      () => applyRetention(root, { maxAgeDays: 30, now: new Date('2026-07-07T00:00:00Z') }),
      /symbolic link|junction|reparse|escaped jail|changed during/i,
    );
  } finally {
    fs.readdirSync = originalReaddirSync;
  }
  assert.equal(swapped, true, 'test must exercise the post-listing swap');
  assert.equal(fs.existsSync(outsideFile), true, 'post-listing swap must not redirect deletion outside');
});

test('executePurgePlan rejects an ordinary app-directory replacement before target inspection', () => {
  const root = workspace();
  const appDir = path.join(root, '.AgentCowork');
  const displaced = path.join(root, '.AgentCowork-original');
  const target = path.join(appDir, 'conversations');
  const sentinel = path.join(target, 'replacement-must-survive.json');
  const plan = buildPurgePlan(root, { scope: 'conversations' });
  const originalLstatSync = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = ((candidate: string) => {
    if (!swapped && path.resolve(String(candidate)) === path.resolve(target)) {
      swapped = true;
      fs.renameSync(appDir, displaced);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(sentinel, '{"replacement":true}', 'utf8');
    }
    return originalLstatSync(candidate);
  }) as typeof fs.lstatSync;

  try {
    assert.throws(
      () => executePurgePlan(plan, { confirm: true }),
      /changed during|managed directory|path boundary/i,
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(swapped, true, 'test must replace the app directory after boundary creation');
  assert.equal(fs.existsSync(sentinel), true, 'replacement content must not be deleted');
});

test('applyRetention rejects an ordinary app-directory replacement before traversal', () => {
  const root = workspace();
  const appDir = path.join(root, '.AgentCowork');
  const displaced = path.join(root, '.AgentCowork-original');
  const runsRoot = path.join(appDir, 'runs');
  const sentinel = path.join(runsRoot, 'replacement-old.json');
  const oldTime = new Date('2026-01-01T00:00:00Z');
  const originalLstatSync = fs.lstatSync;
  let swapped = false;
  fs.lstatSync = ((candidate: string) => {
    if (!swapped && path.resolve(String(candidate)) === path.resolve(runsRoot)) {
      swapped = true;
      fs.renameSync(appDir, displaced);
      fs.mkdirSync(runsRoot, { recursive: true });
      fs.writeFileSync(sentinel, '{"replacement":true}', 'utf8');
      fs.utimesSync(sentinel, oldTime, oldTime);
    }
    return originalLstatSync(candidate);
  }) as typeof fs.lstatSync;

  try {
    assert.throws(
      () => applyRetention(root, {
        maxAgeDays: 30,
        now: new Date('2026-07-07T00:00:00Z'),
      }),
      /changed during|managed directory|path boundary/i,
    );
  } finally {
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(swapped, true, 'test must replace the app directory after boundary creation');
  assert.equal(fs.existsSync(sentinel), true, 'replacement retention data must not be deleted');
});

test('executePurgePlan rejects an ordinary nested-directory replacement after listing', () => {
  const root = workspace();
  const conversations = path.join(root, '.AgentCowork', 'conversations');
  const ownerDir = path.join(conversations, 'ordinary-swap');
  const displaced = path.join(conversations, 'ordinary-swap-original');
  const victim = path.join(ownerDir, 'old.json');
  fs.mkdirSync(ownerDir, { recursive: true });
  fs.writeFileSync(victim, '{"original":true}', 'utf8');
  const plan = buildPurgePlan(root, { scope: 'conversations' });

  const originalReaddirSync = fs.readdirSync;
  const originalLstatSync = fs.lstatSync;
  let ownerListings = 0;
  let armed = false;
  let swapped = false;
  fs.readdirSync = ((...args: unknown[]) => {
    const result = Reflect.apply(originalReaddirSync, fs, args);
    if (path.resolve(String(args[0])) === path.resolve(ownerDir)) {
      ownerListings += 1;
      if (ownerListings === 2) armed = true;
    }
    return result;
  }) as typeof fs.readdirSync;
  fs.lstatSync = ((candidate: string) => {
    if (armed && !swapped && path.resolve(String(candidate)) === path.resolve(victim)) {
      swapped = true;
      fs.renameSync(ownerDir, displaced);
      fs.mkdirSync(ownerDir);
      fs.writeFileSync(victim, '{"replacement":true}', 'utf8');
    }
    return originalLstatSync(candidate);
  }) as typeof fs.lstatSync;

  try {
    assert.throws(
      () => executePurgePlan(plan, { confirm: true }),
      /changed during|managed path parent changed|path boundary/i,
    );
  } finally {
    fs.readdirSync = originalReaddirSync;
    fs.lstatSync = originalLstatSync;
  }
  assert.equal(swapped, true, 'test must replace the nested directory after its deletion listing');
  assert.equal(fs.existsSync(victim), true, 'replacement nested content must not be deleted');
});
