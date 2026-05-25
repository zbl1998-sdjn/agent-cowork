import assert from 'node:assert/strict';
import test from 'node:test';
import { createDocxDocument, createPdfDocument, createPptxPresentation } from '../src/artifacts/office-writers.js';
import { readZipEntries } from '../src/workspace/zip-utils.js';

function zipText(buffer, name) {
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
  assert.doesNotMatch(text, /\(paren \) and slash \\/);
});
