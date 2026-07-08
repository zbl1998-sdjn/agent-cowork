// Office/PDF 文件写出:零依赖手写 docx / pptx / pdf 二进制(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:把简单的标题+段落/幻灯片/行文本规格,直接拼成 OOXML(打包成 zip)或
//       最小 PDF 字节流;所有文本入 XML/PDF 前先转义,避免破坏结构。
// 依赖:workspace/zip-utils(createZip 打 OOXML 包);PDF 为纯字节手写,无外部库。
// 导出:createDocxDocument / createPptxPresentation / createPdfDocument(均返回 Buffer)
import { createZip } from '../workspace/zip-utils.js';
import { createCjkPdfDocument } from './pdf-cjk-font.js';

export type DocxDocumentSpec = {
  title?: string;
  paragraphs?: string[];
};

export type PptxSlideSpec = {
  title?: string;
  bullets?: string[];
  body?: string[] | string;
};

export type PptxPresentationSpec = {
  title?: string;
  slides?: PptxSlideSpec[];
};

export type PdfDocumentSpec = {
  title?: string;
  lines?: string[];
};

/** XML 转义,确保文本安全嵌入 OOXML(含 ' → &apos;)。 */
// XML 1.0 非法控制字符(除 \t=9 \n=10 \r=13):0-8、11、12、14-31。源里若含 NUL/响铃等
// (脏数据/二进制被误读为文本),会让生成的 OOXML 成为非法 XML,Word/PPT 报「文件损坏无法打开」。
function isIllegalXmlChar(n: number): boolean {
  return n <= 8 || n === 11 || n === 12 || (n >= 14 && n <= 31);
}

function stripXmlControlChars(text: string): string {
  let out = '';
  for (const ch of text) if (!isIllegalXmlChar(ch.codePointAt(0) ?? 0)) out += ch;
  return out;
}

function escapeXml(value: unknown): string {
  return stripXmlControlChars(String(value ?? ''))
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** 把任意输入摊平成去空、去首尾空白的文本行,最多 80 行;全空则用 fallback 兜底。 */
function normalizedLines(values: unknown[] | unknown, fallback = 'Agent Cowork 产物'): string[] {
  const lines = (Array.isArray(values) ? values : [values])
    .flatMap((value) => String(value ?? '').split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines.slice(0, 80) : [fallback];
}

/** 生成一个 Word 段落 XML(保留空白,文本转义)。 */
function xmlParagraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** 由标题+段落生成最小可打开的 .docx(OOXML zip 包)Buffer。 */
export function createDocxDocument(spec: DocxDocumentSpec = {}): Buffer {
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

/** 生成一个幻灯片文本框形状 XML(坐标/尺寸单位为 EMU,字号为 OOXML 半点单位)。 */
function slideShape(id: number, name: string, text: string, x: number, y: number, cx: number, cy: number, fontSize = 1800): string {
  return '<p:sp>' +
    `<p:nvSpPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="${fontSize}"/><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody>` +
    '</p:sp>';
}

/** 生成单页幻灯片 XML:一个标题框 + 一个项目符号正文框。 */
function slideXml(slide: PptxSlideSpec, index: number): string {
  const title = String(slide?.title || `Slide ${index + 1}`);
  const bullets = normalizedLines(slide?.bullets || slide?.body || [], '');
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
    '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    slideShape(2, 'Title', title, 685800, 457200, 7772400, 914400, 3200) +
    slideShape(3, 'Body', bullets.map((item) => `• ${item}`).join('\n'), 914400, 1600200, 7315200, 4114800) +
    '</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>';
}

/** 由标题+多张幻灯片生成最小可打开的 .pptx;空 slides 用占位页兜底,并同步生成各 part 的关系/类型声明。 */
export function createPptxPresentation(spec: PptxPresentationSpec = {}): Buffer {
  const { title = 'Agent Cowork 演示', slides = [] } = spec;
  const safeSlides: PptxSlideSpec[] = slides.length ? slides : [{ title, bullets: ['暂无内容'] }];
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

/** 转义 PDF 文本字面量:非 ASCII 字符降级为 ?,并转义反斜杠与圆括号。 */
function pdfLiteral(value: unknown): string {
  return String(value ?? '')
    .replace(/[^\x20-\x7e]/g, '?')
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/** 手写最小单页 PDF:逐对象拼字节并计算 xref 偏移,Helvetica 12pt 自上而下排行(最多 36 行)。 */
export function createPdfDocument(spec: PdfDocumentSpec = {}): Buffer {
  const { title = 'Agent Cowork PDF', lines = [] } = spec;
  const rawLines = normalizedLines([title, ...lines], title);
  const hasCjk = rawLines.some((line) => /[぀-ヿ㐀-鿿＀-￯]/.test(line));
  // 含中文且有可嵌入的 CJK 字体时,走 CIDFontType2 子集嵌入,真实渲染中文(Chrome PDF 已视觉验收)。
  if (hasCjk) {
    const cjk = createCjkPdfDocument({ title, lines: rawLines.slice(1) });
    if (cjk) return cjk;
  }
  // 回退:基础 Helvetica/WinAnsi 引擎不含 CJK 字形(pdfLiteral 把 CJK 替换成 '?');无字体可嵌入时
  // 加 ASCII 提示指向同名 .docx/.txt(中文完整正确),避免用户被满屏 '?' 误导。
  const noticed = hasCjk
    ? [
        '[Note] This basic PDF engine cannot render Chinese/CJK glyphs (shown as ?).',
        'Use the .docx or .txt version for the full, correct Chinese content.',
        '',
        ...rawLines,
      ]
    : rawLines;
  const textLines = noticed.slice(0, 40);
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
