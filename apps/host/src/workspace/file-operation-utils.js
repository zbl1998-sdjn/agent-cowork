import crypto from 'node:crypto';
import fs from 'node:fs';

/** @param {unknown} value @param {string} name @returns {string} */
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
