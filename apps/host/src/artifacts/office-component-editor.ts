// Office/Web 组件编辑总适配器(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:识别格式、建立统一编辑会话、校验并发版本，并把局部修改写回为新的文件字节。
import crypto from 'node:crypto';
import path from 'node:path';

import { readDocxSections, writeDocxChanges } from './docx-component-editor.js';
import type {
  EditableArtifactChange,
  EditableArtifactKind,
  EditableArtifactSession,
} from './office-editor-types.js';
import { readPptxSections, writePptxChanges } from './pptx-component-editor.js';
import { readXlsxSections, writeXlsxChanges } from './xlsx-component-editor.js';
import { createZip, readZipEntries } from '../workspace/zip-utils.js';

export type {
  EditableArtifactChange,
  EditableArtifactKind,
  EditableArtifactNode,
  EditableArtifactSection,
  EditableArtifactSession,
} from './office-editor-types.js';

const MAX_HTML_BYTES = 2 * 1024 * 1024;

function revision(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function editableArtifactKind(name: string): EditableArtifactKind {
  const extension = path.extname(name).toLowerCase();
  if (extension === '.docx') return 'docx';
  if (extension === '.xlsx') return 'xlsx';
  if (extension === '.pptx') return 'pptx';
  if (extension === '.html' || extension === '.htm') return 'html';
  throw new Error('Only DOCX, XLSX, PPTX, HTML and HTM artifacts can be edited visually');
}

export function openEditableArtifact(name: string, content: Buffer): EditableArtifactSession {
  const kind = editableArtifactKind(name);
  if (kind === 'html') {
    if (content.length > MAX_HTML_BYTES) throw new Error('HTML artifact exceeds the 2 MB visual editing limit');
    return {
      kind,
      name,
      revisionSha256: revision(content),
      sections: [{ id: 'page', label: '网页', nodes: [] }],
      htmlSource: content.toString('utf8'),
    };
  }
  const entries = readZipEntries(content);
  const sections = kind === 'docx'
    ? readDocxSections(entries)
    : kind === 'xlsx'
      ? readXlsxSections(entries)
      : readPptxSections(entries);
  return { kind, name, revisionSha256: revision(content), sections };
}

export function applyEditableArtifact(
  name: string,
  content: Buffer,
  expectedRevisionSha256: string,
  changes: EditableArtifactChange[],
): Buffer {
  if (revision(content) !== expectedRevisionSha256) {
    throw new Error('The artifact changed since it was opened; reload it before saving');
  }
  if (!Array.isArray(changes) || changes.length === 0) throw new Error('At least one visual edit is required');
  if (changes.some((change) => !change?.targetId || typeof change.text !== 'string')) {
    throw new Error('Each visual edit requires a targetId and text');
  }
  const kind = editableArtifactKind(name);
  if (kind === 'html') {
    const documentChange = changes.find((change) => change.targetId === 'document');
    if (!documentChange || changes.length !== 1) throw new Error('HTML visual save requires one complete document snapshot');
    const next = Buffer.from(documentChange.text, 'utf8');
    if (next.length > MAX_HTML_BYTES) throw new Error('HTML artifact exceeds the 2 MB visual editing limit');
    return next;
  }
  const current = openEditableArtifact(name, content);
  const nodes = new Map(current.sections.flatMap((section) => section.nodes).map((node) => [node.id, node]));
  for (const change of changes) {
    const node = nodes.get(change.targetId);
    if (!node) throw new Error(`Visual edit target ${change.targetId} was not found`);
    if (node.readOnly) throw new Error(`Visual edit target ${change.targetId} is read-only`);
  }
  const entries = readZipEntries(content);
  const nextEntries = kind === 'docx'
    ? writeDocxChanges(entries, changes)
    : kind === 'xlsx'
      ? writeXlsxChanges(entries, changes)
      : writePptxChanges(entries, changes);
  return createZip(nextEntries);
}
