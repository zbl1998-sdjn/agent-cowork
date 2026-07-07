import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocxDocument, createPdfDocument, createPptxPresentation } from '../src/artifacts/office-writers.js';
import { readZipEntries } from '../src/workspace/zip-utils.js';

function zipText(buffer: Buffer, name: string): string {
  const entry = readZipEntries(buffer).find((item) => item.name === name);
  assert.ok(entry, `${name} exists in zip`);
  return entry.content.toString('utf8');
}

test('createDocxDocument writes escaped WordprocessingML content', () => {
  const docx = createDocxDocument({
    title: '项目总结',
    paragraphs: ['客户 & 交付 <风险>', '下一步：确认验收'],
  });
  const documentXml = zipText(docx, 'word/document.xml');

  assert.match(documentXml, /项目总结/);
  assert.match(documentXml, /客户 &amp; 交付 &lt;风险&gt;/);
  assert.match(zipText(docx, '[Content_Types].xml'), /wordprocessingml\.document\.main\+xml/);
});

test('createPptxPresentation writes escaped slide text', () => {
  const pptx = createPptxPresentation({
    title: '管理摘要',
    slides: [{ title: '第一页', bullets: ['进展 <正常>', '风险 & 待确认'] }],
  });
  const slideXml = zipText(pptx, 'ppt/slides/slide1.xml');

  assert.match(slideXml, /第一页/);
  assert.match(slideXml, /进展 &lt;正常&gt;/);
  assert.match(slideXml, /风险 &amp; 待确认/);
  assert.match(zipText(pptx, 'ppt/presentation.xml'), /sldIdLst/);
});

test('createPdfDocument writes a bounded PDF document', () => {
  const pdf = createPdfDocument({
    title: 'Office PDF',
    lines: ['Summary line', 'paren ) and slash \\ are escaped'],
  });
  const text = pdf.toString('latin1');

  assert.match(text, /^%PDF-1\.4/);
  assert.match(text, /xref/);
  assert.match(text, /Summary line/);
  assert.ok(!/\(paren \) and slash \\/.test(text));
  // 纯 ASCII 内容不应触发 CJK 提示
  assert.ok(!/basic PDF engine cannot render/.test(text), 'ASCII content must not get the CJK notice');
});

test('createPdfDocument on CJK content: embeds a CJK font when available, else ASCII notice', () => {
  const withCjk = createPdfDocument({ title: '中文标题', lines: ['这是一行中文', 'ascii line'] }).toString('latin1');
  assert.match(withCjk, /^%PDF-1\.4/, 'still a valid PDF');
  const embedded = withCjk.includes('CIDFontType2');
  const noticed = /basic PDF engine cannot render Chinese\/CJK/.test(withCjk);
  // 有可嵌入的 CJK 字体(如 Windows simhei)→ 真实字体嵌入渲染中文;否则回退到诚实提示。
  assert.ok(embedded || noticed, 'CJK content must embed a CJK font or fall back to the notice');
  assert.ok(!(embedded && noticed), 'exactly one path, not both');
});
