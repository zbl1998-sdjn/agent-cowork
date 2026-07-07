// 中文 PDF 字体嵌入(dogfood 完整修复)——CIDFontType2 子集结构校验
// 视觉正确性由 Chrome PDF 查看器人工验收(见 dogfood 记录);这里校验结构与体积。
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCjkPdfDocument, isCjkFontAvailable, hasCjk } from '../src/artifacts/pdf-cjk-font.js';

test('hasCjk detects Chinese but not pure ASCII', () => {
  assert.equal(hasCjk('这是中文'), true);
  assert.equal(hasCjk('plain ascii 123'), false);
  assert.equal(hasCjk('mixed 中文 abc'), true);
});

test('createCjkPdfDocument embeds a subsetted CIDFontType2 font (skips if no CJK font)', (t) => {
  if (!isCjkFontAvailable()) { t.skip('本机无可嵌入的 CJK 字体,跳过'); return; }
  const buf = createCjkPdfDocument({ title: '中文标题', lines: ['第一行中文内容', 'ascii ok', '结论:完成。'] });
  assert.ok(buf, 'font available → returns a buffer');
  const text = (buf as Buffer).toString('latin1');
  assert.match(text, /^%PDF-1\.4/, 'valid PDF header');
  assert.ok(text.trimEnd().endsWith('%%EOF'), 'valid PDF trailer');
  assert.match(text, /\/Subtype \/Type0/, 'Type0 composite font');
  assert.match(text, /\/Subtype \/CIDFontType2/, 'CIDFontType2 descendant');
  assert.match(text, /\/Encoding \/Identity-H/, 'Identity-H encoding');
  assert.match(text, /\/FontFile2/, 'embedded font program');
  assert.match(text, /\/CIDToGIDMap \/Identity/, 'identity CID→GID');
  // 子集应远小于整字(simhei ~9MB);典型几十 KB。
  assert.ok((buf as Buffer).length < 2_000_000, `subset PDF should be small, got ${(buf as Buffer).length}`);
});
