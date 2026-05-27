// @ts-check
import { readZipEntries } from '../../workspace/zip-utils.js';

/**
 * @typedef {{ headers: string[], rows: string[][], totalRowsSeen: number, truncated: boolean }} ParsedXlsxTable
 * @typedef {import('../../workspace/zip-utils.js').ZipReadEntry} ZipReadEntry
 */

/** @param {string} value @returns {string} */
function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** @param {string} xml @returns {string} */
function xmlText(xml) {
  return decodeXmlEntities(String(xml || '').replace(/<[^>]+>/g, ''));
}

/** @param {string} ref @returns {number | null} */
function columnIndexFromRef(ref) {
  const letters = /^[A-Z]+/i.exec(String(ref || ''))?.[0];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

/** @param {ZipReadEntry[]} entries @param {string} name @returns {string} */
function zipEntryText(entries, name) {
  return entries.find((entry) => entry.name === name)?.content.toString('utf8') || '';
}

/** @param {ZipReadEntry[]} entries @returns {string[]} */
function readSharedStrings(entries) {
  const xml = zipEntryText(entries, 'xl/sharedStrings.xml');
  if (!xml) return [];
  /** @type {string[]} */
  const strings = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    strings.push(xmlText(match[1] || ''));
  }
  return strings;
}

/** @param {ZipReadEntry[]} entries @returns {ZipReadEntry} */
function firstWorksheet(entries) {
  const worksheet = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  if (!worksheet) {
    throw new Error('XLSX worksheet not found');
  }
  return worksheet;
}

/** @param {string} attrs @returns {Record<string, string>} */
function parseAttrs(attrs) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const match of String(attrs || '').matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    out[match[1]] = decodeXmlEntities(match[2]);
  }
  return out;
}

/** @param {string} body @param {Record<string, string>} attrs @param {string[]} sharedStrings @returns {string} */
function cellValue(body, attrs, sharedStrings) {
  const type = attrs.t || '';
  if (type === 's') {
    const index = Number.parseInt(/<v>([\s\S]*?)<\/v>/i.exec(body)?.[1] || '', 10);
    return Number.isInteger(index) ? sharedStrings[index] || '' : '';
  }
  if (type === 'inlineStr') {
    return xmlText(body);
  }
  if (type === 'b') {
    return /<v>\s*1\s*<\/v>/i.test(body) ? 'TRUE' : 'FALSE';
  }
  return decodeXmlEntities(/<v>([\s\S]*?)<\/v>/i.exec(body)?.[1] || '');
}

/** @param {string} rowXml @param {string[]} sharedStrings @returns {string[]} */
function readRow(rowXml, sharedStrings) {
  /** @type {string[]} */
  const values = [];
  let nextIndex = 0;
  for (const match of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    const attrs = parseAttrs(match[1] || '');
    const index = columnIndexFromRef(attrs.r) ?? nextIndex;
    values[index] = cellValue(match[2] || '', attrs, sharedStrings);
    nextIndex = index + 1;
  }
  return Array.from({ length: values.length }, (_, index) => values[index] || '');
}

/** @param {Buffer} buffer @param {number} maxRows @returns {ParsedXlsxTable} */
export function parseXlsxTable(buffer, maxRows) {
  const limit = Math.max(1, Number(maxRows) || 1);
  const entries = readZipEntries(buffer, {
    maxEntries: 500,
    maxEntryBytes: 8 * 1024 * 1024,
    maxTotalUncompressedBytes: 16 * 1024 * 1024,
  });
  const sharedStrings = readSharedStrings(entries);
  const worksheetXml = firstWorksheet(entries).content.toString('utf8');
  const rowMatches = [...worksheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)];
  const rows = rowMatches.slice(0, limit + 1).map((match) => readRow(match[1] || '', sharedStrings));
  const headers = (rows[0] || []).map((header, index) => header || `Column ${index + 1}`);
  return {
    headers,
    rows: rows.slice(1),
    totalRowsSeen: Math.max(rowMatches.length - 1, 0),
    truncated: rowMatches.length > limit + 1,
  };
}
