import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertTrustedPath } from '../security/path-policy.js';
import { readTextFile } from './file-reader.js';

function normalizeOp(op) {
  if (!op || typeof op !== 'object') {
    throw new Error('Each file operation must be an object');
  }
  const type = String(op.type || '').toLowerCase();
  return { ...op, type };
}

function hashContent(content) {
  return crypto.createHash('sha256').update(String(content ?? '')).digest('hex');
}

function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function pathExists(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function previewWrite(op, trustedRoot) {
  const target = assertTrustedPath(path.resolve(op.path), trustedRoot);
  const content = String(op.content ?? '');
  const overwrite = op.overwrite === true;
  const beforeExists = fileExists(target);
  if (beforeExists && !overwrite) {
    throw new Error(`Overwrite disabled: ${target}`);
  }

  const beforeHash = beforeExists ? readTextFile(target, { trustedRoot }).sha256 : null;
  const afterHash = hashContent(content);

  return {
    type: 'write',
    path: target,
    beforeHash,
    afterHash,
  };
}

function previewRename(op, trustedRoot) {
  const source = assertTrustedPath(path.resolve(op.path), trustedRoot);
  const base = path.dirname(source);
  const target = assertTrustedPath(path.resolve(base, op.newName), trustedRoot);
  if (source === target) {
    throw new Error(`Rename target equals source: ${source}`);
  }
  if (!fileExists(source)) {
    throw new Error(`Source not found: ${source}`);
  }
  if (pathExists(target)) {
    throw new Error(`Target already exists: ${target}`);
  }
  const beforeHash = readTextFile(source, { trustedRoot }).sha256;
  return {
    type: 'rename',
    path: source,
    targetPath: target,
    beforeHash,
    afterHash: beforeHash,
  };
}

function previewMove(op, trustedRoot) {
  const source = assertTrustedPath(path.resolve(op.from), trustedRoot);
  const target = assertTrustedPath(path.resolve(op.to), trustedRoot);
  if (source === target) {
    throw new Error(`Move target equals source: ${source}`);
  }
  if (!fileExists(source)) {
    throw new Error(`Source not found: ${source}`);
  }
  if (pathExists(target)) {
    throw new Error(`Target already exists: ${target}`);
  }
  const beforeHash = readTextFile(source, { trustedRoot }).sha256;
  return {
    type: 'move',
    path: source,
    targetPath: target,
    beforeHash,
    afterHash: beforeHash,
  };
}

export function previewFileOperations(operations, options = {}) {
  const trustedRoot = options.trustedRoot;
  if (!trustedRoot) {
    throw new Error('trustedRoot is required');
  }
  if (!Array.isArray(operations)) {
    throw new Error('operations must be an array');
  }

  const previews = [];
  for (const rawOp of operations) {
    const op = normalizeOp(rawOp);
    if (op.type === 'delete') {
      throw new Error('delete is forbidden');
    }
    if (op.type === 'write') {
      previews.push(previewWrite(op, trustedRoot));
      continue;
    }
    if (op.type === 'rename') {
      previews.push(previewRename(op, trustedRoot));
      continue;
    }
    if (op.type === 'move') {
      previews.push(previewMove(op, trustedRoot));
      continue;
    }
    throw new Error(`Unsupported operation type: ${op.type}`);
  }
  return { operations: previews };
}

function applyWrite(op, options) {
  const parentDir = path.dirname(op.path);
  fs.mkdirSync(parentDir, { recursive: true });
  fs.writeFileSync(op.path, String(op.content ?? ''), 'utf8');
}

function applyRename(op) {
  fs.renameSync(op.path, op.targetPath);
}

function applyMove(op) {
  fs.mkdirSync(path.dirname(op.targetPath), { recursive: true });
  fs.renameSync(op.path, op.targetPath);
}

export function applyFileOperations(operations, options = {}) {
  const trustedRoot = options.trustedRoot;
  const journalWriter = options.journalWriter;
  const preview = previewFileOperations(operations, { trustedRoot });
  const results = [];

  for (const op of preview.operations) {
    const event = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: new Date().toISOString(),
      action: op.type,
      path: op.path,
      targetPath: op.targetPath,
      beforeHash: op.beforeHash,
      afterHash: op.afterHash,
      status: 'pending',
    };
    if (journalWriter?.append) {
      journalWriter.append(event);
    }

    if (op.type === 'write') {
      const original = operations.find((o) => o.type === 'write' && path.resolve(o.path) === op.path);
      applyWrite(Object.assign(op, original || {}));
      const after = readTextFile(op.path, { trustedRoot });
      event.status = 'applied';
      event.afterHash = after.sha256;
      event.size = after.size;
      if (journalWriter?.append) {
        journalWriter.append({ ...event, stage: 'after' });
      }
      results.push({ ...event, status: 'applied' });
      continue;
    }

    if (op.type === 'rename') {
      applyRename(op);
      event.status = 'applied';
      if (journalWriter?.append) {
        journalWriter.append({ ...event, stage: 'after' });
      }
      results.push({ ...event, status: 'applied' });
      continue;
    }

    if (op.type === 'move') {
      applyMove(op);
      event.status = 'applied';
      if (journalWriter?.append) {
        journalWriter.append({ ...event, stage: 'after' });
      }
      results.push({ ...event, status: 'applied' });
    }
  }

  return { applied: results };
}
