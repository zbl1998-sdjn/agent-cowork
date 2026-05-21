import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { extractDocumentText } from '../src/workspace/document-extractor.js';
import { createZip } from '../src/workspace/zip-utils.js';
import { createXlsxWorkbook } from '../src/artifacts/xlsx-writer.js';
import { makeTestWorkspace } from './test-fixtures.js';

test('extracts text from docx xlsx pptx and simple pdf', () => {
  const root = makeTestWorkspace('kcw-docs');
  const docx = path.join(root, 'meeting.docx');
  fs.writeFileSync(
    docx,
    createZip([
      {
        name: 'word/document.xml',
        content: '<w:document><w:body><w:p><w:r><w:t>行动项：准备周报</w:t></w:r></w:p></w:body></w:document>',
      },
    ]),
  );
  assert.match(extractDocumentText(docx, { trustedRoot: root }).content, /准备周报/);

  const xlsx = path.join(root, 'finance.xlsx');
  fs.writeFileSync(
    xlsx,
    createXlsxWorkbook({
      columns: ['供应商', '金额'],
      rows: [['Moonshot', '1280']],
    }),
  );
  assert.match(extractDocumentText(xlsx, { trustedRoot: root }).content, /Moonshot/);

  const pptx = path.join(root, 'deck.pptx');
  fs.writeFileSync(
    pptx,
    createZip([
      {
        name: 'ppt/slides/slide1.xml',
        content: '<p:sld><a:p><a:r><a:t>项目进度</a:t></a:r></a:p></p:sld>',
      },
    ]),
  );
  assert.match(extractDocumentText(pptx, { trustedRoot: root }).content, /项目进度/);

  const pdf = path.join(root, 'note.pdf');
  fs.writeFileSync(pdf, '%PDF-1.4\n1 0 obj\nBT (invoice amount 128) Tj ET\nendobj\n%%EOF', 'latin1');
  assert.match(extractDocumentText(pdf, { trustedRoot: root }).content, /invoice amount 128/);
});
