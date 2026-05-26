// Load workspace image files as OpenAI-compatible multipart `image_url` content
// parts (base64 data URLs) so the agent can reason over uploaded screenshots/PDF
// pages — the Claude Cowork "drop an image in chat" capability. All paths are
// jailed to the trusted workspace root; non-images and oversized files are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from '../security/path-policy.js';

/**
 * @typedef {{ type: 'image_url', image_url: { url: string } }} ImageContentPart
 */

/** @type {Readonly<Record<string, string>>} */
const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};
const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8MB per image

/** @param {unknown} p @returns {boolean} */
export function isImagePath(p) {
  return Object.prototype.hasOwnProperty.call(MIME_BY_EXT, path.extname(String(p || '')).toLowerCase());
}

// Returns an array of { type:'image_url', image_url:{ url } } for each readable
// image among `paths` (relative to, or under, trustedRoot).
/** @param {{ trustedRoot?: string, paths?: unknown[], maxImages?: number }} options @returns {ImageContentPart[]} */
export function loadImageContentParts({ trustedRoot, paths = [], maxImages = 6 }) {
  const root = path.resolve(trustedRoot || process.cwd());
  /** @type {ImageContentPart[]} */
  const out = [];
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (out.length >= maxImages) break;
    if (!raw || !isImagePath(raw)) continue;
    const imagePath = String(raw);
    let abs;
    try {
      abs = path.isAbsolute(imagePath) ? assertTrustedPath(imagePath, root) : assertTrustedPath(path.join(root, imagePath), root);
    } catch { continue; }
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES) continue;
    let buf;
    try { buf = fs.readFileSync(abs); } catch { continue; }
    const mime = MIME_BY_EXT[path.extname(abs).toLowerCase()] || 'application/octet-stream';
    out.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } });
  }
  return out;
}
