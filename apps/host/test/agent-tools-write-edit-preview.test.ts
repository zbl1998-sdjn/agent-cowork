import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createAgentTools } from '../src/engine/agent-tools.js';
import { agentTool } from './helpers/agent.js';
import { tempRoot } from './helpers/host-http.js';

test('Write approvalPreview shows a null before side for a brand-new file', () => {
  const root = tempRoot('kcw-agent-preview-');
  const tools = createAgentTools({ trustedRoot: root });
  const preview = agentTool(tools, 'Write').approvalPreview?.({ path: 'fresh.txt', content: 'hello\n' });
  assert.deepEqual(preview, { kind: 'text', path: 'fresh.txt', before: null, after: 'hello\n' });
});

test('Write approvalPreview diffs against the file already on disk', () => {
  const root = tempRoot('kcw-agent-preview-');
  fs.writeFileSync(path.join(root, 'existing.txt'), 'old content\n', 'utf8');
  const tools = createAgentTools({ trustedRoot: root });
  const preview = agentTool(tools, 'Write').approvalPreview?.({ path: 'existing.txt', content: 'new content\n' });
  assert.deepEqual(preview, { kind: 'text', path: 'existing.txt', before: 'old content\n', after: 'new content\n' });
});

test('Write approvalPreview never throws for an unreadable/invalid path, and falls back to no before side', () => {
  const root = tempRoot('kcw-agent-preview-');
  const tools = createAgentTools({ trustedRoot: root });
  const preview = agentTool(tools, 'Write').approvalPreview?.({ path: '../outside.txt', content: 'x' });
  assert.equal(preview?.kind, 'text');
  assert.equal((preview as { before: string | null }).before, null);
});

test('Write approvalPreview does not create an owner claim that would break the real write afterwards', async () => {
  const root = tempRoot('kcw-agent-preview-');
  const tools = createAgentTools({ trustedRoot: root });
  const write = agentTool(tools, 'Write');
  // 先取一次预览(模拟审批卡片渲染),再真正执行写入——预览本身不应留下任何会让
  // 后续真实写入冲突的痕迹(如 owner claim)。
  write.approvalPreview?.({ path: 'brand-new.txt', content: 'v1' });
  const result = await write.handler({ path: 'brand-new.txt', content: 'v1' });
  assert.equal((result as { ok: boolean }).ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'brand-new.txt'), 'utf8'), 'v1');
});

test('Edit approvalPreview is a targeted old_string/new_string diff, not the whole file', () => {
  const root = tempRoot('kcw-agent-preview-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'line one\nline two\nline three\n', 'utf8');
  const tools = createAgentTools({ trustedRoot: root });
  const preview = agentTool(tools, 'Edit').approvalPreview?.({ path: 'a.txt', old_string: 'line two', new_string: 'line 2' });
  assert.deepEqual(preview, { kind: 'text', path: 'a.txt', before: 'line two', after: 'line 2' });
});
