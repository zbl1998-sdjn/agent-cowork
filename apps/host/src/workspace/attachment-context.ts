// 附件上下文(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:多模态附件管线——把上传文件分类并提取可用上下文:文本/PDF/DOCX 抽成文本摘录,图片仅
//       作为引用携带(交给视觉模型)。供 chat/recipe 层把附件转成提示词上下文。
// 依赖:同层 document-extractor。导出:buildAttachmentContext。
import path from 'node:path';
import { omitUndefined } from '../util/object.js';
import { extractDocumentText } from './document-extractor.js';

export type AttachmentInput = { path?: string | undefined; fullPath?: string | undefined; relativePath?: string | undefined };
export type AttachmentItem = {
  path: string;
  kind: string;
  ext?: string;
  note?: string;
  relativePath?: string;
  size?: number;
  sha256?: string;
  excerpt?: string;
  error?: string;
};
export type AttachmentContext = {
  items: AttachmentItem[];
  counts: { total: number; images: number; texts: number; errors: number };
};
export type AttachmentContextOptions = {
  files?: Array<string | AttachmentInput>;
  trustedRoot?: string;
  maxSize?: unknown;
  maxItems?: number;
  excerptBytes?: number;
  includeFile?: (fullPath: string) => boolean;
};

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

/** 把附件列表加工成 { items, counts }:图片记为引用,文档抽取摘录,失败项标 error(不中断)。 */
export function buildAttachmentContext(
  { files = [], trustedRoot, maxSize, maxItems = 12, excerptBytes = 2000, includeFile }: AttachmentContextOptions = {},
): AttachmentContext {
  const list = Array.isArray(files) ? files.slice(0, maxItems) : [];
  const items: AttachmentItem[] = [];
  for (const entry of list) {
    const filePath = typeof entry === 'string' ? entry : (entry && (entry.path || entry.fullPath || entry.relativePath));
    if (!filePath) continue;
    if (includeFile && !includeFile(filePath)) continue;
    const ext = path.extname(String(filePath)).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      items.push({ path: filePath, kind: 'image', ext, note: '图片附件 (需视觉模型解析)' });
      continue;
    }
    try {
      const doc = extractDocumentText(filePath, omitUndefined({ trustedRoot, maxSize }));
      items.push(omitUndefined({
        path: doc.path,
        relativePath: doc.relativePath,
        kind: doc.kind || 'text',
        size: doc.size,
        sha256: doc.sha256,
        excerpt: (doc.content || '').slice(0, excerptBytes),
      }));
    } catch (err) {
      const error = (err || {}) as { message?: string };
      items.push(omitUndefined({ path: filePath, kind: 'error', error: error.message }));
    }
  }
  return {
    items,
    counts: {
      total: items.length,
      images: items.filter((i) => i.kind === 'image').length,
      texts: items.filter((i) => typeof i.excerpt === 'string' && i.excerpt).length,
      errors: items.filter((i) => i.kind === 'error').length,
    },
  };
}
