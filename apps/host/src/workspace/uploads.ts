// 上传导入(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:把前端上传的 base64 文件安全落入工作区。相对路径净化(禁绝对路径/.. 等)、拒绝「活动内容」
//       扩展名(exe/bat/js/html…,上传是数据不是程序)、限单文件/总量/数量,目标路径经 create 校验。
// 安全:类型白名单 + 路径 jail(plan/01 D.12-13)。依赖:L0 path-policy。
// 导出:sanitizeUploadRelativePath / importUploadedFiles。
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPathForCreate } from '../security/path-policy.js';

const DEFAULT_MAX_FILES = 80;
const DEFAULT_MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;

export type UploadFile = {
  relativePath?: string | undefined;
  name?: string | undefined;
  contentBase64?: string | undefined;
  size?: number | undefined;
};
export type UploadOptions = {
  trustedRoot?: string;
  files?: UploadFile[];
  batchId?: string;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxFileBytes?: number;
};
export type ImportedFile = { relativePath: string; path: string; size: number };
export type UploadImportResult = { batchId: string; uploadRoot: string; imported: ImportedFile[]; totalBytes: number };

function uniqueBatchId(date = new Date()): string {
  const timestamp = date.toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
  const suffix = Math.random().toString(16).slice(2, 8);
  return `${timestamp}-${suffix}`;
}

function cleanPathPart(part: unknown): string {
  const value = String(part || '').trim();
  if (!value || value === '.' || value === '..') {
    throw new Error('Upload path contains an invalid segment');
  }
  if (/[:*?"<>|]/.test(value)) {
    throw new Error(`Upload path contains unsupported characters: ${value}`);
  }
  return value;
}

// 会执行代码或脚本的活动内容扩展名;上传入口只接收数据文件,不接收可执行程序。
const BLOCKED_UPLOAD_EXTENSIONS = new Set([
  '.exe', '.com', '.scr', '.msi', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe',
  '.js', '.jse', '.wsf', '.wsh', '.hta', '.jar', '.lnk', '.reg', '.dll', '.sh',
  '.html', '.htm', '.svg', '.xhtml', '.mht', '.mhtml',
]);

/** 净化上传相对路径:必须相对、逐段合法、拒绝活动内容扩展名;返回规范化后的系统相对路径。 */
export function sanitizeUploadRelativePath(input: unknown): string {
  const raw = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!raw || path.isAbsolute(raw) || /^[a-zA-Z]:/.test(raw)) {
    throw new Error('Upload relativePath is required and must be relative');
  }
  const parts = raw.split('/').filter(Boolean).map(cleanPathPart);
  if (parts.length === 0) {
    throw new Error('Upload relativePath is required');
  }
  const filename = parts[parts.length - 1];
  if (!filename) {
    throw new Error('Upload relativePath is required');
  }
  const ext = path.extname(filename).toLowerCase();
  if (BLOCKED_UPLOAD_EXTENSIONS.has(ext)) {
    throw new Error(`Upload type not allowed: ${ext} (active content is blocked)`);
  }
  return parts.join(path.sep);
}

function decodeBase64File(file: unknown): Buffer {
  if (!file || typeof file !== 'object') {
    throw new Error('Each upload file must be an object');
  }
  const input = file as UploadFile;
  if (typeof input.contentBase64 !== 'string') {
    throw new Error('Upload file contentBase64 is required');
  }
  const buffer = Buffer.from(input.contentBase64, 'base64');
  if (buffer.length !== Number(input.size)) {
    throw new Error(`Upload size mismatch for ${input.relativePath || input.name || 'file'}`);
  }
  return buffer;
}

/** 批量导入上传文件:校验数量/大小/总量,逐个净化路径、解码 base64、写入工作区上传目录,返回导入清单。 */
export function importUploadedFiles({
  trustedRoot,
  files,
  batchId = uniqueBatchId(),
  maxFiles = DEFAULT_MAX_FILES,
  maxTotalBytes = DEFAULT_MAX_TOTAL_BYTES,
  maxFileBytes = DEFAULT_MAX_FILE_BYTES,
}: UploadOptions = {}): UploadImportResult {
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
  const imported: ImportedFile[] = [];

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
