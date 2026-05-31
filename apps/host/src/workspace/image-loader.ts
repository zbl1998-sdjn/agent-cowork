// 图片加载(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:把工作区图片读成 OpenAI 兼容的 image_url 多模态内容块(base64 data URL),让 Agent 能
//       「在聊天里看图」。所有路径限定在可信根内;非图片与超大文件跳过(单图上限 8MB)。
// 依赖:L0 path-policy。导出:isImagePath / loadImageContentParts。
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';

export type ImageContentPart = { type: 'image_url'; image_url: { url: string } };

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB per image

/** 路径扩展名是否为受支持图片类型。 */
export function isImagePath(p: unknown): boolean {
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, path.extname(String(p || '')).toLowerCase());
}

// 为 paths 中每个可读图片返回一个 image_url 内容块(路径限定可信根内,跳过非图片/超大)。
export function loadImageContentParts({ trustedRoot, paths = [], maxImages = 6 }: { trustedRoot?: string; paths?: unknown[]; maxImages?: number }): ImageContentPart[] {
  const root = path.resolve(trustedRoot || process.cwd());
  const out: ImageContentPart[] = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (out.length >= maxImages) break;
    if (!raw || !isImagePath(raw)) continue;
    const imagePath = String(raw);
    let abs: string;
    try {
      abs = path.isAbsolute(imagePath) ? assertTrustedPath(imagePath, root) : assertTrustedPath(path.join(root, imagePath), root);
    } catch { continue; }
    let stat: fs.Stats;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
    let buf: Buffer;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    out.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
  }
  return out;
}
