// 文件操作·纯工具(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:file-operations / file-rollback 共用的小工具——必填路径校验、SHA-256 哈希、
//       文件/路径存在性判断。无副作用、易单测。导出:requiredPath/hashBuffer/hashFile/fileExists/pathExists。
import crypto from 'node:crypto';
import fs from 'node:fs';

/** 断言为非空字符串路径,否则抛 `<name> is required`。 */
export function requiredPath(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  return value;
}

export function hashBuffer(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

export function hashFile(filePath: string): string {
  return hashBuffer(fs.readFileSync(filePath));
}

export function fileExists(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

export function pathExists(targetPath: string): boolean {
  try {
    fs.statSync(targetPath);
    return true;
  } catch {
    return false;
  }
}
