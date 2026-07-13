import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyEditableArtifact,
  openEditableArtifact,
} from '../src/artifacts/office-component-editor.js';
import { createDocxDocument, createPptxPresentation } from '../src/artifacts/office-writers.js';
import { createXlsxWorkbook } from '../src/artifacts/xlsx-writer.js';
import { createZip, readZipEntries } from '../src/workspace/zip-utils.js';

function zipText(buffer: Buffer, name: string): string {
  const entry = readZipEntries(buffer).find((candidate) => candidate.name === name);
  assert.ok(entry, `${name} should exist`);
  return entry.content.toString('utf8');
}

test('DOCX edits one selected paragraph and preserves unrelated package parts', () => {
  const original = createDocxDocument({ title: '周报', paragraphs: ['第一段', '第二段'] });
  const extended = createZip([
    ...readZipEntries(original).map((entry) => ({ name: entry.name, content: entry.content })),
    { name: 'custom/preserved.bin', content: Buffer.from([1, 2, 3]) },
  ]);
  const session = openEditableArtifact('report.docx', extended);
  const target = session.sections.flatMap((section) => section.nodes).find((node) => node.text === '第二段');
  assert.ok(target);

  const changed = applyEditableArtifact('report.docx', extended, session.revisionSha256, [
    { targetId: target.id, text: '第二段（已确认）' },
  ]);

  const reopened = openEditableArtifact('report.docx', changed);
  assert.deepEqual(
    reopened.sections.flatMap((section) => section.nodes).map((node) => node.text),
    ['周报', '第一段', '第二段（已确认）'],
  );
  assert.deepEqual(readZipEntries(changed).find((entry) => entry.name === 'custom/preserved.bin')?.content, Buffer.from([1, 2, 3]));
});

test('XLSX edits an addressed cell while leaving its neighbours intact', () => {
  const original = createXlsxWorkbook({ sheetName: '客户', columns: ['姓名', '状态'], rows: [['林先生', '待确认']] });
  const session = openEditableArtifact('clients.xlsx', original);
  const target = session.sections[0]?.nodes.find((node) => node.address === 'B2');
  assert.ok(target);

  const changed = applyEditableArtifact('clients.xlsx', original, session.revisionSha256, [
    { targetId: target.id, text: '已确认' },
  ]);
  const sheetXml = zipText(changed, 'xl/worksheets/sheet1.xml');

  assert.match(sheetXml, /林先生/);
  assert.match(sheetXml, /已确认/);
  assert.doesNotMatch(sheetXml, /待确认/);
});

test('PPTX edits one selected shape without flattening the slide', () => {
  const original = createPptxPresentation({
    title: '汇报',
    slides: [{ title: '进展', bullets: ['已完成设计', '待验收'] }],
  });
  const session = openEditableArtifact('deck.pptx', original);
  const target = session.sections.flatMap((section) => section.nodes).find((node) => node.text.includes('待验收'));
  assert.ok(target);

  const changed = applyEditableArtifact('deck.pptx', original, session.revisionSha256, [
    { targetId: target.id, text: '客户已验收' },
  ]);
  const slideXml = zipText(changed, 'ppt/slides/slide1.xml');

  assert.match(slideXml, /进展/);
  assert.match(slideXml, /客户已验收/);
  assert.match(slideXml, /<p:sp>/);
});

test('HTML saves a complete edited snapshot and rejects stale revisions', () => {
  const original = Buffer.from('<main><h1>旧标题</h1><p>说明</p></main>', 'utf8');
  const session = openEditableArtifact('page.html', original);
  const nextSource = '<main><h1>新标题</h1><p style="color: rgb(10, 20, 30)">说明</p></main>';
  const changed = applyEditableArtifact('page.html', original, session.revisionSha256, [
    { targetId: 'document', text: nextSource },
  ]);

  assert.equal(changed.toString('utf8'), nextSource);
  assert.throws(
    () => applyEditableArtifact('page.html', original, '0'.repeat(64), [{ targetId: 'document', text: nextSource }]),
    /changed since it was opened/i,
  );
});
