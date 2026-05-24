import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertTrustedPath, assertTrustedPathForCreate } from '../security/path-policy.js';
import { previewFileOperations } from './file-operations.js';

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeFile(root, file) {
  const full = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const safe = assertTrustedPath(full, root);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) throw new Error(`file not found: ${file}`);
  return safe;
}

function safeTarget(root, targetDir, ...parts) {
  return assertTrustedPathForCreate(path.join(root, String(targetDir || 'organized'), ...parts), root);
}

function targetWithSuffix(target, used) {
  const parsed = path.parse(target);
  let current = target;
  let n = 2;
  while (used.has(current) || fs.existsSync(current)) {
    current = path.join(parsed.dir, `${parsed.name}-${n}${parsed.ext}`);
    n += 1;
  }
  used.add(current);
  return current;
}

export function planFileOrganization({
  trustedRoot,
  files,
  mode = 'byExtension',
  targetDir = 'organized',
  renamePrefix = 'file',
} = {}) {
  if (!trustedRoot) throw new Error('trustedRoot is required');
  if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array');
  const root = path.resolve(trustedRoot);
  const safeFiles = files.map((file) => safeFile(root, file));
  const operations = [];
  const usedTargets = new Set();

  if (mode === 'dedupe') {
    const seen = new Map();
    for (const file of safeFiles) {
      const hash = fileHash(file);
      if (!seen.has(hash)) {
        seen.set(hash, file);
        continue;
      }
      operations.push({ type: 'move', from: file, to: targetWithSuffix(safeTarget(root, targetDir, 'duplicates', path.basename(file)), usedTargets) });
    }
  } else if (mode === 'rename') {
    safeFiles.forEach((file, index) => {
      const ext = path.extname(file);
      operations.push({ type: 'rename', path: file, newName: `${String(renamePrefix || 'file').trim() || 'file'}-${index + 1}${ext}` });
    });
  } else if (mode === 'byExtension') {
    for (const file of safeFiles) {
      const ext = path.extname(file).replace(/^\./, '').toLowerCase() || 'no-extension';
      operations.push({ type: 'move', from: file, to: targetWithSuffix(safeTarget(root, targetDir, ext, path.basename(file)), usedTargets) });
    }
  } else {
    throw new Error(`unsupported organize mode: ${mode}`);
  }

  return { operations, preview: previewFileOperations(operations, { trustedRoot: root }) };
}
