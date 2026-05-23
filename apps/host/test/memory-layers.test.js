import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadLayeredMemory } from '../src/memory/memory-layers.js';

function seed() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-home-'));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-proj-'));
  fs.mkdirSync(path.join(home, '.AgentCowork'), { recursive: true });
  fs.mkdirSync(path.join(root, '.AgentCowork'), { recursive: true });
  fs.writeFileSync(path.join(home, '.AgentCowork', 'MEMORY.md'), '用户偏好：简洁中文', 'utf8');
  fs.writeFileSync(path.join(root, '.AgentCowork', 'MEMORY.md'), '项目：Agent Cowork', 'utf8');
  fs.writeFileSync(path.join(root, '.AgentCowork', 'MEMORY.local.md'), '本地：测试机', 'utf8');
  return { home, root };
}

test('loadLayeredMemory merges present layers in precedence order', () => {
  const { home, root } = seed();
  const out = loadLayeredMemory({ trustedRoot: root, userHome: home, sessionMemory: '会话：刚上传发票' });
  // user before project before local before session
  assert.ok(out.text.indexOf('用户偏好') < out.text.indexOf('项目：Agent'));
  assert.ok(out.text.indexOf('项目：Agent') < out.text.indexOf('本地：测试机'));
  assert.ok(out.text.indexOf('本地：测试机') < out.text.indexOf('会话：刚上传发票'));
  const present = out.layers.filter((l) => l.present).map((l) => l.layer);
  assert.deepEqual(present, ['user', 'project', 'local', 'session']);
});

test('loadLayeredMemory returns empty text when no layers present', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-empty-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-eh-'));
  const out = loadLayeredMemory({ trustedRoot: root, userHome: home });
  assert.equal(out.text, '');
  assert.equal(out.layers.length, 5);
});
