// PPTX 形状编辑适配器(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:按幻灯片暴露带文字的形状，并在保留形状/主题/布局的情况下替换目标 a:t 文本。
import type { EditableArtifactChange, EditableArtifactSection } from './office-editor-types.js';
import { naturalPartOrder, replaceXmlTagText, textFromXmlTags } from './office-editor-xml.js';
import type { ZipCreateEntry, ZipReadEntry } from '../workspace/zip-utils.js';

const SLIDE_PART_RE = /^ppt\/slides\/slide(\d+)\.xml$/;
const SHAPE_RE = /<p:sp\b[^>]*>[\s\S]*?<\/p:sp>/g;

export function readPptxSections(entries: ZipReadEntry[]): EditableArtifactSection[] {
  return entries
    .filter((entry) => SLIDE_PART_RE.test(entry.name))
    .sort((left, right) => naturalPartOrder(left.name, right.name))
    .map((entry, slideIndex) => {
      const nodes = [...entry.content.toString('utf8').matchAll(SHAPE_RE)]
        .map((match, shapeIndex) => ({
          id: `slide:${slideIndex}:shape:${shapeIndex}`,
          type: 'shape' as const,
          text: textFromXmlTags(match[0], 'a:t'),
        }))
        .filter((node) => node.text.length > 0);
      return { id: `slide:${slideIndex}`, label: `第 ${slideIndex + 1} 页`, nodes };
    });
}

export function writePptxChanges(entries: ZipReadEntry[], changes: EditableArtifactChange[]): ZipCreateEntry[] {
  const edits = new Map(changes.map((change) => [change.targetId, change.text]));
  let slideIndex = 0;
  return [...entries]
    .sort((left, right) => {
      const leftSlide = SLIDE_PART_RE.test(left.name);
      const rightSlide = SLIDE_PART_RE.test(right.name);
      return leftSlide && rightSlide ? naturalPartOrder(left.name, right.name) : 0;
    })
    .map((entry) => {
      if (!SLIDE_PART_RE.test(entry.name)) return { name: entry.name, content: entry.content };
      let shapeIndex = 0;
      const currentSlide = slideIndex;
      slideIndex += 1;
      const xml = entry.content.toString('utf8').replace(SHAPE_RE, (shape) => {
        const id = `slide:${currentSlide}:shape:${shapeIndex}`;
        shapeIndex += 1;
        return edits.has(id) ? replaceXmlTagText(shape, 'a:t', edits.get(id) ?? '') : shape;
      });
      return { name: entry.name, content: xml };
    });
}
