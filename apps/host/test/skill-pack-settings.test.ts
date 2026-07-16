import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { readDisabledSkillPacks, setSkillPackEnabled } from '../src/skills/skill-pack-settings.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acw-skillset-'));
}

test('disabled list defaults to empty and round-trips through toggling', () => {
  const root = makeRoot();
  assert.deepEqual([...readDisabledSkillPacks(root)], []);

  assert.deepEqual(setSkillPackEnabled(root, 'pdf-processing', false), ['pdf-processing']);
  assert.deepEqual(setSkillPackEnabled(root, 'weekly-report', false), ['pdf-processing', 'weekly-report']);
  assert.deepEqual([...readDisabledSkillPacks(root)].sort(), ['pdf-processing', 'weekly-report']);

  assert.deepEqual(setSkillPackEnabled(root, 'pdf-processing', true), ['weekly-report']);
  assert.deepEqual([...readDisabledSkillPacks(root)], ['weekly-report']);
});

test('invalid pack names are rejected with 400 and never persisted', () => {
  const root = makeRoot();
  assert.throws(() => setSkillPackEnabled(root, '../escape', false), (error) => {
    assert.equal((error as Error & { statusCode?: unknown }).statusCode, 400);
    return true;
  });
  assert.throws(() => setSkillPackEnabled(root, 'Bad--Name', false), /不合法/);
  assert.deepEqual([...readDisabledSkillPacks(root)], []);
});

test('corrupt or hand-edited settings degrade safely and drop invalid entries', () => {
  const root = makeRoot();
  const file = path.join(root, '.AgentCowork', 'settings', 'skill-packs.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });

  fs.writeFileSync(file, '不是 JSON');
  assert.deepEqual([...readDisabledSkillPacks(root)], []);

  fs.writeFileSync(file, JSON.stringify({ disabled: ['ok-pack', '../escape', 42, 'Bad--Name'] }));
  assert.deepEqual([...readDisabledSkillPacks(root)], ['ok-pack']);
});
