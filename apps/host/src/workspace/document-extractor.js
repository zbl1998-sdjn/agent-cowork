import fs from 'node:fs';
import path from 'node:path';
import { assertReadableWorkspacePath } from '../security/path-policy.js';
import { readTextFile } from './file-reader.js';
import { readZipEntries } from './zip-utils.js';
import {
  DEFAULT_MAX_BYTES,
  cappedMaxBytes,
  compactLines,
  decodePdfLiteral,
  decodeXmlEntities,
  sha256,
  xmlToText,
} from './document-extractor-utils.js';

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.json', '.log']);

/**
 * @typedef {import('./zip-utils.js').ZipReadEntry} ZipReadEntry
 * @typedef {{ trustedRoot?: string, root?: string, maxSize?: unknown }} ExtractOptions
 * @typedef {{ path: string, relativePath: string, kind: string, size: number, sha256: string, content: string }} ExtractedDocument
 */

/** @param {ZipReadEntry[]} entries @param {string} name @returns {string} */
function zipEntryText(entries, name) {
  const entry = entries.find((item) => item.name === name);
  return entry ? entry.content.toString('utf8') : '';
}

/** @param {ZipReadEntry[]} entries @returns {string} */
function extractDocx(entries) {
  const documentXml = zipEntryText(entries, 'word/document.xml');
  if (!documentXml) {
    throw new Error('DOCX document.xml not found');
  }
  return xmlToText(documentXml);
}

/** @param {ZipReadEntry[]} entries @returns {string[]} */
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

/** @param {string} xml @param {string[]} strings @returns {string} */
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

/** @param {ZipReadEntry[]} entries @returns {string} */
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

/** @param {ZipReadEntry[]} entries @returns {string} */
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

/** @param {Buffer} buffer @returns {string} */
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

/** @param {string} filePath @param {ExtractOptions} [options] @returns {ExtractedDocument} */
export function extractDocumentText(filePath, options = {}) {
  const trustedRoot = options.trustedRoot ?? options.root;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  const maxBytes = cappedMaxBytes(options.maxSize ?? DEFAULT_MAX_BYTES);
  const safePath = assertReadableWorkspacePath(filePath, trustedRoot);
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

/** @param {string} filePath @returns {boolean} */
export function isExtractableDocument(filePath) {
  return TEXT_EXTENSIONS.has(path.extname(filePath).toLowerCase()) || ['.docx', '.xlsx', '.pptx', '.pdf'].includes(path.extname(filePath).toLowerCase());
}
