// XLSX 单元格编辑适配器(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:按工作表暴露现有单元格；字符串/数值可编辑，公式只读；写回时保留工作簿其余部件和单元格样式属性。
import type { EditableArtifactChange, EditableArtifactNode, EditableArtifactSection } from './office-editor-types.js';
import { decodeOfficeXml, escapeOfficeXml, naturalPartOrder, textFromXmlTags } from './office-editor-xml.js';
import type { ZipCreateEntry, ZipReadEntry } from '../workspace/zip-utils.js';

const SHEET_PART_RE = /^xl\/worksheets\/sheet(\d+)\.xml$/;
const CELL_RE = /<c\b([^>]*\br="([A-Z]+\d+)"[^>]*)>([\s\S]*?)<\/c>/g;

function sharedStrings(entries: ZipReadEntry[]): string[] {
  const part = entries.find((entry) => entry.name === 'xl/sharedStrings.xml');
  if (!part) return [];
  return [...part.content.toString('utf8').matchAll(/<si\b[^>]*>[\s\S]*?<\/si>/g)]
    .map((match) => textFromXmlTags(match[0], 't'));
}

function sheetNames(entries: ZipReadEntry[]): string[] {
  const part = entries.find((entry) => entry.name === 'xl/workbook.xml');
  if (!part) return [];
  return [...part.content.toString('utf8').matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\/>/g)]
    .map((match) => decodeOfficeXml(match[1]));
}

function cellText(attributes: string, body: string, strings: string[]): Pick<EditableArtifactNode, 'text' | 'readOnly'> {
  const formula = textFromXmlTags(body, 'f');
  if (formula) return { text: `=${formula}`, readOnly: true };
  if (/\bt="inlineStr"/.test(attributes)) return { text: textFromXmlTags(body, 't') };
  const value = textFromXmlTags(body, 'v');
  if (/\bt="s"/.test(attributes)) return { text: strings[Number.parseInt(value, 10)] ?? '' };
  return { text: value };
}

export function readXlsxSections(entries: ZipReadEntry[]): EditableArtifactSection[] {
  const strings = sharedStrings(entries);
  const names = sheetNames(entries);
  return entries
    .filter((entry) => SHEET_PART_RE.test(entry.name))
    .sort((left, right) => naturalPartOrder(left.name, right.name))
    .map((entry, sheetIndex) => {
      const nodes = [...entry.content.toString('utf8').matchAll(CELL_RE)].flatMap((match) => {
        const address = match[2];
        if (!address) return [];
        return [{
          id: `sheet:${sheetIndex}:cell:${address}`,
          type: 'cell' as const,
          address,
          ...cellText(match[1] || '', match[3] || '', strings),
        }];
      });
      return { id: `sheet:${sheetIndex}`, label: names[sheetIndex] || `工作表 ${sheetIndex + 1}`, nodes };
    });
}

function editableCell(attributes: string, text: string): string {
  const withoutType = attributes.replace(/\s+t="[^"]*"/g, '');
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<c${withoutType} t="inlineStr"><is><t${preserve}>${escapeOfficeXml(text)}</t></is></c>`;
}

export function writeXlsxChanges(entries: ZipReadEntry[], changes: EditableArtifactChange[]): ZipCreateEntry[] {
  const edits = new Map(changes.map((change) => [change.targetId, change.text]));
  let sheetIndex = 0;
  return entries
    .slice()
    .sort((left, right) => {
      const leftSheet = SHEET_PART_RE.test(left.name);
      const rightSheet = SHEET_PART_RE.test(right.name);
      return leftSheet && rightSheet ? naturalPartOrder(left.name, right.name) : 0;
    })
    .map((entry) => {
      if (!SHEET_PART_RE.test(entry.name)) return { name: entry.name, content: entry.content };
      const currentSheet = sheetIndex;
      sheetIndex += 1;
      const xml = entry.content.toString('utf8').replace(CELL_RE, (whole, attributes: string, address: string, body: string) => {
        const id = `sheet:${currentSheet}:cell:${address}`;
        if (!edits.has(id)) return whole;
        if (/<f\b/.test(body)) throw new Error(`Formula cell ${address} is read-only`);
        return editableCell(attributes, edits.get(id) ?? '');
      });
      return { name: entry.name, content: xml };
    });
}
