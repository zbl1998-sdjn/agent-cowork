// 文件操作·纯工具(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:file-operations / file-rollback 共用的小工具——必填路径校验、SHA-256 哈希、
//       文件/路径存在性判断。无副作用、易单测。导出:requiredPath/hashBuffer/hashFile/fileExists/pathExists。
import crypto from 'node:crypto';
import fs from 'node:fs';

/** 断言为非空字符串路径,否则抛 `<name> is required`。 @param {unknown} value @param {string} name @returns {string} */
export function requiredPath(value, name) {
  if (typeof value !== 'string' || !value) throw new Error(`${name} is required`);
  return value;
}

/** @param {Buffer} buffer @returns {string} */
export function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** @param {string} filePath @returns {string} */
export function hashFile(filePath) {
  return hashBuffer(fs.readFileSync(filePath));
}

/** @param {string} p @returns {boolean} */
export function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** @param {string} p @returns {boolean} */
export function pathExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}
