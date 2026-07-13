// DOCX 段落编辑适配器(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:把 WordprocessingML 段落映射为可选择节点，并只替换目标段落的 w:t 文本。
import type { EditableArtifactChange, EditableArtifactSection } from './office-editor-types.js';
import { replaceXmlTagText, textFromXmlTags } from './office-editor-xml.js';
import type { ZipCreateEntry, ZipReadEntry } from '../workspace/zip-utils.js';

const DOCUMENT_PART = 'word/document.xml';
const PARAGRAPH_RE = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;

export function readDocxSections(entries: ZipReadEntry[]): EditableArtifactSection[] {
  const part = entries.find((entry) => entry.name === DOCUMENT_PART);
  if (!part) throw new Error('DOCX main document part is missing');
  const xml = part.content.toString('utf8');
  const nodes = [...xml.matchAll(PARAGRAPH_RE)]
    .map((match, paragraphIndex) => ({
      id: `paragraph:${paragraphIndex}`,
      type: 'paragraph' as const,
      text: textFromXmlTags(match[0], 'w:t'),
    }))
    .filter((node) => node.text.length > 0);
  return [{ id: 'document', label: '文档正文', nodes }];
}

export function writeDocxChanges(
  entries: ZipReadEntry[],
  changes: EditableArtifactChange[],
): ZipCreateEntry[] {
  const edits = new Map(changes.map((change) => [change.targetId, change.text]));
  return entries.map((entry) => {
    if (entry.name !== DOCUMENT_PART) return { name: entry.name, content: entry.content };
    let paragraphIndex = 0;
    const xml = entry.content.toString('utf8').replace(PARAGRAPH_RE, (paragraph) => {
      const id = `paragraph:${paragraphIndex}`;
      paragraphIndex += 1;
      if (!edits.has(id)) return paragraph;
      return replaceXmlTagText(paragraph, 'w:t', edits.get(id) ?? '');
    });
    return { name: entry.name, content: xml };
  }).map((entry) => entry);
}
