import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { searchWorkspace } from '../src/workspace/file-search.js';

// 回归:UI 的「引用文件」按钮插入裸 @ 时 query 为空。旧实现 throw 'query is required',
// 导致按钮点了不弹菜单。现在空 query 当"文件选择器"用——列出工作区最近文件。
test('searchWorkspace: 空 query 列出文件而非报错(引用文件按钮的来源)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsearch-empty-'));
  writeFileSync(path.join(root, 'alpha.md'), 'a');
  writeFileSync(path.join(root, 'beta.txt'), 'b');
  const res = searchWorkspace({ trustedRoot: root, query: '', maxResults: 8 });
  assert.equal(res.query, '');
  assert.ok(res.results.length >= 2, '空 query 应列出工作区文件');
  assert.ok(res.results.every((r) => typeof r.path === 'string' && r.path.length > 0));
});

test('searchWorkspace: 非空 query 仍按关键词命中、不误伤别的文件', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'fsearch-kw-'));
  writeFileSync(path.join(root, 'login-error.md'), 'x');
  writeFileSync(path.join(root, 'payment-recon.md'), 'y');
  const res = searchWorkspace({ trustedRoot: root, query: 'login', maxResults: 8 });
  assert.ok(res.results.some((r) => r.path.includes('login')), '应命中 login');
  assert.ok(!res.results.some((r) => r.path.includes('payment')), '不应命中 payment');
});
