// @ts-check

import { createZip } from '../workspace/zip-utils.js';

/**
 * @typedef {{ title?: string, paragraphs?: string[] }} DocxDocumentSpec
 * @typedef {{ title?: string, bullets?: string[], body?: string[] | string }} PptxSlideSpec
 * @typedef {{ title?: string, slides?: PptxSlideSpec[] }} PptxPresentationSpec
 * @typedef {{ title?: string, lines?: string[] }} PdfDocumentSpec
 */

/**
 * @param {unknown} value
 * @returns {string}
 */
function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * @param {unknown[] | unknown} values
 * @param {string} [fallback]
 * @returns {string[]}
 */
function normalizedLines(values, fallback = 'Agent Cowork 产物') {
  const lines = (Array.isArray(values) ? values : [values])
    .flatMap((value) => String(value ?? '').split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines.slice(0, 80) : [fallback];
}

/**
 * @param {string} text
 * @returns {string}
 */
function xmlParagraph(text) {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/**
 * @param {DocxDocumentSpec} [spec]
 * @returns {Buffer}
 */
export function createDocxDocument(spec = {}) {
  const { title = 'Agent Cowork 文档', paragraphs = [] } = spec;
  const lines = normalizedLines([title, ...paragraphs], title);
  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    `<w:body>${lines.map(xmlParagraph).join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body>` +
    '</w:document>';
  return createZip([
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        '</Relationships>',
    },
    { name: 'word/document.xml', content: documentXml },
  ]);
}

/**
 * @param {number} id
 * @param {string} name
 * @param {string} text
 * @param {number} x
 * @param {number} y
 * @param {number} cx
 * @param {number} cy
 * @param {number} [fontSize]
 * @returns {string}
 */
function slideShape(id, name, text, x, y, cx, cy, fontSize = 1800) {
  return '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="${fontSize}"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody>` +
    '</p:sp>';
}

/**
 * @param {PptxSlideSpec} slide
 * @param {number} index
 * @returns {string}
 */
function slideXml(slide, index) {
  const title = String(slide?.title || `Slide ${index + 1}`);
  const bullets = normalizedLines(slide?.bullets || slide?.body || [], '');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    slideShape(2, 'Title', title, 685800, 457200, 7772400, 914400, 3200) +
    slideShape(3, 'Body', bullets.map((item) => `• ${item}`).join('\n'), 914400, 1600200, 7315200, 4114800) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

/**
 * @param {PptxPresentationSpec} [spec]
 * @returns {Buffer}
 */
export function createPptxPresentation(spec = {}) {
  const { title = 'Agent Cowork 演示', slides = [] } = spec;
  const safeSlides = slides.length ? slides : [{ title, bullets: ['暂无内容'] }];
  const slideEntries = safeSlides.map((slide, index) => ({
    name: `ppt/slides/slide${index + 1}.xml`,
    content: slideXml(slide, index),
  }));
  const overrides = safeSlides
    .map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join('');
  const relationships = safeSlides
    .map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`)
    .join('');
  const slideIds = safeSlides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 1}"/>`).join('');
  return createZip([
    {
      name: '[Content_Types].xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        overrides +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
        '</Relationships>',
    },
    {
      name: 'ppt/presentation.xml',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        `<p:sldIdLst>${slideIds}</p:sldIdLst><p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`,
    },
    {
      name: 'ppt/_rels/presentation.xml.rels',
      content:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relationships}</Relationships>`,
    },
    ...slideEntries,
  ]);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function pdfLiteral(value) {
  return String(value ?? '')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * @param {PdfDocumentSpec} [spec]
 * @returns {Buffer}
 */
export function createPdfDocument(spec = {}) {
  const { title = 'Agent Cowork PDF', lines = [] } = spec;
  const textLines = normalizedLines([title, ...lines], title).slice(0, 36);
  const stream = textLines
    .map((line, index) => `BT /F1 12 Tf 72 ${780 - index * 20} Td (${pdfLiteral(line)}) Tj ET`)
    .join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xrefOffset = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { body += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
