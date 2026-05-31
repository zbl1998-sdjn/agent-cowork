// XLSX 表格解析(host · L1 领域层 · tools/data)
// ---------------------------------------------------------------------------
// 职责:零依赖解析 .xlsx——把它当 zip 解开,读 sharedStrings 与首个 worksheet 的 XML,
//       还原单元格(共享串/内联串/布尔/数值)并按列引用(A1)定位,产出表头 + 行。
// 依赖:workspace/zip-utils(安全解压)。导出:parseXlsxTable。
import { readZipEntries } from '../../workspace/zip-utils.js';

export type ParsedXlsxTable = { headers: string[]; rows: string[][]; totalRowsSeen: number; truncated: boolean };
type ZipReadEntry = { name: string; content: Buffer };

function decodeXmlEntities(value: string): string {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function xmlText(xml: string): string {
  return decodeXmlEntities(String(xml || '').replace(/<[^>]+>/g, ''));
}

function columnIndexFromRef(ref: string): number | null {
  const letters = /^[A-Z]+/i.exec(String(ref || ''))?.[0];
  if (!letters) return null;
  let index = 0;
  for (const letter of letters.toUpperCase()) {
    index = index * 26 + (letter.charCodeAt(0) - 64);
  }
  return index - 1;
}

function zipEntryText(entries: ZipReadEntry[], name: string): string {
  return entries.find((entry) => entry.name === name)?.content.toString('utf8') || '';
}

function readSharedStrings(entries: ZipReadEntry[]): string[] {
  const xml = zipEntryText(entries, 'xl/sharedStrings.xml');
  if (!xml) return [];
  const strings: string[] = [];
  for (const match of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
    strings.push(xmlText(match[1] || ''));
  }
  return strings;
}

function firstWorksheet(entries: ZipReadEntry[]): ZipReadEntry {
  const worksheet = entries
    .filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))[0];
  if (!worksheet) {
    throw new Error('XLSX worksheet not found');
  }
  return worksheet;
}

function parseAttrs(attrs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const match of String(attrs || '').matchAll(/\b([A-Za-z_:][\w:.-]*)="([^"]*)"/g)) {
    out[match[1]] = decodeXmlEntities(match[2]);
  }
  return out;
}

function cellValue(body: string, attrs: Record<string, string>, sharedStrings: string[]): string {
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

function readRow(rowXml: string, sharedStrings: string[]): string[] {
  const values: string[] = [];
  let nextIndex = 0;
  for (const match of rowXml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
    const attrs = parseAttrs(match[1] || '');
    const index = columnIndexFromRef(attrs.r) ?? nextIndex;
    values[index] = cellValue(match[2] || '', attrs, sharedStrings);
    nextIndex = index + 1;
  }
  return Array.from({ length: values.length }, (_, index) => values[index] || '');
}

/** 解析 .xlsx 字节为 { headers, rows };首行作表头,超 maxRows 截断并标记 truncated。 */
export function parseXlsxTable(buffer: Buffer, maxRows: number): ParsedXlsxTable {
  const limit = Math.max(1, Number(maxRows) || 1);
  const entries = readZipEntries(buffer, {
    maxEntries: 500,
    maxEntryBytes: 8 * 1024 * 1024,
    maxTotalUncompressedBytes: 16 * 1024 * 1024,
  }) as ZipReadEntry[];
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
