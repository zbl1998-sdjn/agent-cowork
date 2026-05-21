import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';
import { readTextFile } from './file-reader.js';
import { readZipEntries } from './zip-utils.js';

const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log']);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function decodeXmlEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, value) => String.fromCodePoint(Number.parseInt(value, 16)))
    .replace(/&#([0-9]+);/g, (_, value) => String.fromCodePoint(Number.parseInt(value, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function compactLines(text, maxChars = 12000) {
  const compacted = String(text || '')
    .replace(/\u0000/g, ' ')
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
  return compacted.length > maxChars ? `${compacted.slice(0, maxChars)}\n[内容已截断]` : compacted;
}

function xmlToText(xml) {
  return compactLines(
    decodeXmlEntities(
      String(xml || '')
        .replace(/<\?xml[^>]*>/gi, ' ')
        .replace(/<w:tab\s*\/>/gi, '\t')
        .replace(/<a:br\s*\/>/gi, '\n')
        .replace(/<\/(?:w:p|a:p|p|row|worksheet|si)>/gi, '\n')
        .replace(/<\/(?:w:tr|a:tr|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, ' '),
    ),
  );
}

function zipEntryText(entries, name) {
  const entry = entries.find((item) => item.name === name);
  return entry ? entry.content.toString('utf8') : '';
}

function extractDocx(entries) {
  const documentXml = zipEntryText(entries, 'word/document.xml');
  if (!documentXml) {
    throw new Error('DOCX document.xml not found');
  }
  return xmlToText(documentXml);
}

function sharedStrings(entries) {
  const xml = zipEntryText(entries, 'xl/sharedStrings.xml');
  if (!xml) {
    return [];
  }
  const strings = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    strings.push(xmlToText(match[1]));
  }
  return strings;
}

function extractWorksheetText(xml, strings) {
  const values = [];
  for (const match of String(xml || '').matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    const attrs = match[1] || '';
    const body = match[2] || '';
    const type = /t="([^"]+)"/i.exec(attrs)?.[1] || '';
    if (type === 's') {
      const index = Number.parseInt(/<v>([\s\S]*?)<\/v>/i.exec(body)?.[1] || '', 10);
      values.push(strings[index] || '');
      continue;
    }
    if (type === 'inlineStr') {
      values.push(xmlToText(body));
      continue;
    }
    const rawValue = /<v>([\s\S]*?)<\/v>/i.exec(body)?.[1];
    if (rawValue != null) {
      values.push(decodeXmlEntities(rawValue));
    }
  }
  return compactLines(values.join('\n'));
}

function extractXlsx(entries) {
  const strings = sharedStrings(entries);
  const worksheets = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (worksheets.length === 0) {
    throw new Error('XLSX worksheet not found');
  }
  const parts = [];
  for (const sheet of worksheets) {
    const text = extractWorksheetText(sheet.content.toString('utf8'), strings);
    if (text) {
      parts.push(`${sheet.name}\n${text}`);
    }
  }
  return compactLines(parts.join('\n\n'));
}

function extractPptx(entries) {
  const slides = entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (slides.length === 0) {
    throw new Error('PPTX slides not found');
  }
  return compactLines(
    slides
      .map((slide, index) => `Slide ${index + 1}\n${xmlToText(slide.content.toString('utf8'))}`)
      .join('\n\n'),
  );
}

function decodePdfLiteral(input) {
  let output = '';
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i];
    if (ch !== '\\') {
      output += ch;
      continue;
    }
    const next = input[i + 1];
    i += 1;
    if (next === 'n') output += '\n';
    else if (next === 'r') output += '\r';
    else if (next === 't') output += '\t';
    else if (next === 'b') output += '\b';
    else if (next === 'f') output += '\f';
    else if (/[0-7]/.test(next || '')) {
      let octal = next;
      for (let j = 0; j < 2 && /[0-7]/.test(input[i + 1] || ''); j += 1) {
        octal += input[i + 1];
        i += 1;
      }
      output += String.fromCharCode(Number.parseInt(octal, 8));
    } else {
      output += next || '';
    }
  }
  return output;
}

function extractPdf(buffer) {
  const latin1 = buffer.toString('latin1');
  const literals = [];
  for (const match of latin1.matchAll(/\(((?:\\.|[^\\()]){1,2000})\)\s*(?:Tj|'|"|TJ)?/g)) {
    literals.push(decodePdfLiteral(match[1]));
  }
  const literalText = compactLines(literals.join('\n'));
  if (literalText.length >= 8) {
    return literalText;
  }
  return compactLines(latin1.replace(/[^\x09\x0a\x0d\x20-\x7e]+/g, ' '));
}

export function extractDocumentText(filePath, options = {}) {
  const trustedRoot = options.trustedRoot ?? options.root;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const maxBytes = Number(options.maxSize ?? DEFAULT_MAX_BYTES);
  const safePath = assertTrustedPath(filePath, trustedRoot);
  const stat = fs.statSync(safePath);
  if (!stat.isFile()) {
    throw new Error('Path is not a file');
  }
  if (stat.size > maxBytes) {
    throw new Error(`File exceeds max extract size (${maxBytes} bytes)`);
  }

  const extension = path.extname(safePath).toLowerCase();
  if (TEXT_EXTENSIONS.has(extension)) {
    const text = readTextFile(safePath, { trustedRoot, maxSize: maxBytes });
    return {
      path: safePath,
      relativePath: path.relative(trustedRoot, safePath).replace(/\\/g, '/'),
      kind: extension.slice(1) || 'text',
      size: stat.size,
      sha256: text.sha256,
      content: compactLines(text.content),
    };
  }

  const buffer = fs.readFileSync(safePath);
  let content;
  let kind;
  if (extension === '.docx') {
    kind = 'docx';
    content = extractDocx(readZipEntries(buffer));
  } else if (extension === '.xlsx') {
    kind = 'xlsx';
    content = extractXlsx(readZipEntries(buffer));
  } else if (extension === '.pptx') {
    kind = 'pptx';
    content = extractPptx(readZipEntries(buffer));
  } else if (extension === '.pdf') {
    kind = 'pdf';
    content = extractPdf(buffer);
  } else {
    throw new Error(`Unsupported document type: ${extension || 'unknown'}`);
  }

  return {
    path: safePath,
    relativePath: path.relative(trustedRoot, safePath).replace(/\\/g, '/'),
    kind,
    size: stat.size,
    sha256: sha256(buffer),
    content: compactLines(content),
  };
}

export function isExtractableDocument(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || ['.docx', '.xlsx', '.pptx', '.pdf'].includes(path.extname(filePath).toLowerCase());
}
