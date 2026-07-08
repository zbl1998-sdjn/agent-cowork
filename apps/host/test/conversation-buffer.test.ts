import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  appendConversationTurn,
  readRecentTurns,
  formatRecentTurns,
  conversationBufferPath,
} from '../src/memory/conversation-buffer.js';
import { tempRoot } from './helpers/host-http.js';

test('appendConversationTurn persists turns and readRecentTurns returns them in order', () => {
  const root = tempRoot('kcw-convbuf-');
  appendConversationTurn(root, 'conv-A', { role: 'user', text: '我的工位号是 555' });
  appendConversationTurn(root, 'conv-A', { role: 'assistant', text: '已记住工位号 555' });

  const turns = readRecentTurns(root, 'conv-A');
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.role, 'user');
  assert.match(String(turns[0]?.text), /555/);
  assert.equal(turns[1]?.role, 'assistant');
  assert.ok(turns[0]?.ts, 'turn should carry a timestamp');
});

test('conversation buffers are isolated per conversationId', () => {
  const root = tempRoot('kcw-convbuf-');
  appendConversationTurn(root, 'conv-A', { role: 'user', text: 'A-only fact 111' });
  appendConversationTurn(root, 'conv-B', { role: 'user', text: 'B-only fact 222' });

  assert.match(String(readRecentTurns(root, 'conv-A')[0]?.text), /111/);
  assert.equal(readRecentTurns(root, 'conv-A').some((t) => /222/.test(t.text)), false);
  assert.match(String(readRecentTurns(root, 'conv-B')[0]?.text), /222/);
});

test('readRecentTurns caps to the requested number of most-recent turns', () => {
  const root = tempRoot('kcw-convbuf-');
  for (let i = 0; i < 10; i += 1) {
    appendConversationTurn(root, 'conv-A', { role: 'user', text: `turn ${i}` });
  }
  const recent = readRecentTurns(root, 'conv-A', { maxTurns: 3 });
  assert.equal(recent.length, 3);
  assert.match(String(recent[0]?.text), /turn 7/);
  assert.match(String(recent[2]?.text), /turn 9/);
});

test('the on-disk buffer rolls to a bounded number of turns (does not grow unbounded)', () => {
  const root = tempRoot('kcw-convbuf-');
  for (let i = 0; i < 200; i += 1) {
    appendConversationTurn(root, 'conv-A', { role: 'user', text: `msg ${i}` }, { maxTurns: 40 });
  }
  const file = conversationBufferPath(root, 'conv-A');
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  assert.ok(lines.length <= 40, `buffer should be capped at 40 lines, got ${lines.length}`);
  // 最新的一定还在
  const all = readRecentTurns(root, 'conv-A', { maxTurns: 100 });
  assert.match(String(all[all.length - 1]?.text), /msg 199/);
});

test('turn text is DLP-redacted before being written to disk (no raw secrets in the buffer)', () => {
  const root = tempRoot('kcw-convbuf-');
  // 刻意用假密钥样式验证脱敏:值绝不会真实使用,仅用于断言不会原样落盘。
  const fakeSecret = 'sk-livetestfakekey000000000000000000'; // allowlist-secret
  appendConversationTurn(root, 'conv-A', { role: 'user', text: `my key is ${fakeSecret} keep it` });
  const raw = fs.readFileSync(conversationBufferPath(root, 'conv-A'), 'utf8');
  assert.equal(raw.includes(fakeSecret), false, 'raw secret must not be persisted');
});

test('conversationId is sanitized so it cannot escape the conversations dir', () => {
  const root = tempRoot('kcw-convbuf-');
  appendConversationTurn(root, '../../evil', { role: 'user', text: 'traversal attempt' });
  // 逃逸尝试不得写到 root 之外
  const escaped = path.join(root, '..', 'evil.jsonl');
  assert.equal(fs.existsSync(escaped), false, 'must not write outside the conversations dir');
  // 归一后的缓冲文件必须存在,且位于 conversations 目录内(用模块自身的 jail 后路径断言,避免手工拼路径受规范化影响)
  const file = conversationBufferPath(root, '../../evil');
  assert.ok(fs.existsSync(file), 'sanitized buffer file should exist');
  assert.match(file.replace(/\\/g, '/'), /\/\.AgentCowork\/conversations\/[A-Za-z0-9_-]+\.jsonl$/);
  // 归一后读回内容正常
  assert.match(String(readRecentTurns(root, '../../evil')[0]?.text), /traversal attempt/);
});

test('formatRecentTurns renders a compact labeled block for system-prompt injection', () => {
  const block = formatRecentTurns([
    { role: 'user', text: '我叫张伟', ts: '2026-07-09T00:00:00.000Z' },
    { role: 'assistant', text: '你好，张伟', ts: '2026-07-09T00:00:01.000Z' },
  ]);
  assert.match(block, /张伟/);
  assert.match(block, /用户|assistant|助手|user/i);
  assert.equal(formatRecentTurns([]), '');
});
