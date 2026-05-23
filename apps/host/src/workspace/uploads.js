import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPathForCreate } from '../security/path-policy.js';

const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

function uniqueBatchId(date = new Date()) {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const suffix = Math.random().toString(16).slice(2, 8);
  return `${timestamp}-${suffix}`;
}

function cleanPathPart(part) {
  const value = String(part || '').trim();
  if (!value || value === '.' || value === '..') {
    throw new Error('Upload path contains an invalid segment');
  }
  if (/[:*?"<>|]/.test(value)) {
    throw new Error(`Upload path contains unsupported characters: ${value}`);
  }
  return value;
}

// Active-content extensions that could execute or run script if later opened by
// the user from the workspace. Uploads are data, not programs — reject these.
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.exe', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.lnk', '.reg', '.dll', '.sh',
  '.html', '.htm', '.svg', '.xhtml', '.mht', '.mhtml',
]);

export function sanitizeUploadRelativePath(input) {
  const raw = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new Error('Upload relativePath is required and must be relative');
  }
  const parts = raw.split('/').filter(Boolean).map(cleanPathPart);
  if (parts.length === 0) {
    throw new Error('Upload relativePath is required');
  }
  const ext = path.extname(parts[parts.length - 1]).toLowerCase();
  if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) {
    throw new Error(`Upload type not allowed: ${ext} (active content is blocked)`);
  }
  return parts.join(path.sep);
}

function decodeBase64File(file) {
  if (!file || typeof file !== 'object') {
    throw new Error('Each upload file must be an object');
  }
  if (typeof file.contentBase64 !== 'string') {
    throw new Error('Upload file contentBase64 is required');
  }
  const buffer = Buffer.from(file.contentBase64, 'base64');
  if (buffer.length !== Number(file.size)) {
    throw new Error(`Upload size mismatch for ${file.relativePath || file.name || 'file'}`);
  }
  return buffer;
}

export function importUploadedFiles({
  trustedRoot,
  files,
  batchId = uniqueBatchId(),
  maxFiles = DEFAULT_MAX_FILES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
} = {}) {
  if (!trustedRoot || typeof trustedRoot !== 'string') {
    throw new Error('trustedRoot is required');
  }
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('files must be a non-empty array');
  }
  if (files.length > maxFiles) {
    throw new Error(`Too many upload files; max ${maxFiles}`);
  }

  const safeRoot = path.resolve(trustedRoot);
  const uploadRoot = assertTrustedPathForCreate(path.join(safeRoot, 'Agent_Cowork上传', batchId), safeRoot);
  let totalBytes = 0;
  const imported = [];

  for (const file of files) {
    const relativePath = sanitizeUploadRelativePath(file.relativePath || file.name);
    const content = decodeBase64File(file);
    if (content.length > maxFileBytes) {
      throw new Error(`Upload file is too large: ${relativePath}`);
    }
    totalBytes += content.length;
    if (totalBytes > maxTotalBytes) {
      throw new Error(`Upload batch is too large; max ${maxTotalBytes} bytes`);
    }

    const targetPath = assertTrustedPathForCreate(path.join(uploadRoot, relativePath), safeRoot);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content);
    imported.push({
      relativePath,
      path: targetPath,
      size: content.length,
    });
  }

  return {
    batchId,
    uploadRoot,
    imported,
    totalBytes,
  };
}
