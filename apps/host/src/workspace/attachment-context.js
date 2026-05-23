import path from 'node:path';
import { extractDocumentText } from './document-extractor.js';

// Multimodal attachment pipeline: classify uploaded files and extract usable
// context. Text/PDF/DOCX are extracted to text (works today); images are
// carried as references for a vision-capable model. Lets the chat/recipe layer
// turn attachments into prompt context.

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

export function buildAttachmentContext({ files = [], trustedRoot, maxSize, maxItems = 12, excerptBytes = 2000 } = {}) {
  const list = Array.isArray(files) ? files.slice(0, maxItems) : [];
  const items = [];
  for (const entry of list) {
    const filePath = typeof entry === 'string' ? entry : (entry && (entry.path || entry.fullPath || entry.relativePath));
    if (!filePath) continue;
    const ext = path.extname(String(filePath)).toLowerCase();
    if (IMAGE_EXT.has(ext)) {
      items.push({ path: filePath, kind: 'image', ext, note: '图片附件 (需视觉模型解析)' });
      continue;
    }
    try {
      const doc = extractDocumentText(filePath, { trustedRoot, maxSize });
      items.push({
        path: doc.path,
        relativePath: doc.relativePath,
        kind: doc.kind || 'text',
        size: doc.size,
        sha256: doc.sha256,
        excerpt: (doc.content || '').slice(0, excerptBytes),
        error: doc.error,
      });
    } catch (err) {
      items.push({ path: filePath, kind: 'error', error: err.message });
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
