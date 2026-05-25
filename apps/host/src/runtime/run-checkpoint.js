// @ts-check

import fs from 'node:fs';
import path from 'node:path';

const RUN_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * @typedef {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }} TokenUsage
 * @typedef {{
 *   runId: string,
 *   step?: number,
 *   phase?: string,
 *   messages?: unknown,
 *   usage?: unknown,
 *   approvedTools?: unknown,
 *   todos?: unknown,
 *   metadata?: unknown,
 * }} CheckpointInput
 * @typedef {{
 *   version: number,
 *   runId: string,
 *   step: number,
 *   phase: string,
 *   updatedAt: string,
 *   messages: unknown[],
 *   usage: TokenUsage,
 *   approvedTools: string[],
 *   todos: unknown[],
 *   metadata: Record<string, unknown>,
 * }} RunCheckpoint
 */

/**
 * @param {unknown} runId
 * @returns {string}
 */
function normalizeRunId(runId) {
  const id = String(runId || '').trim();
  if (!RUN_ID_RE.test(id)) {
    throw new Error('Invalid run id');
  }
  return id;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function numberOrZero(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function cloneArray(value) {
  return Array.isArray(value) ? /** @type {unknown[]} */ (jsonClone(value)) : [];
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function cloneObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (jsonClone(value));
}

/**
 * @param {unknown} value
 * @returns {TokenUsage}
 */
function normalizeUsage(value) {
  const usage = value && typeof value === 'object'
    ? /** @type {Record<string, unknown>} */ (value)
    : {};
  return {
    prompt_tokens: numberOrZero(usage.prompt_tokens),
    completion_tokens: numberOrZero(usage.completion_tokens),
    total_tokens: numberOrZero(usage.total_tokens),
  };
}

/**
 * @param {unknown} value
 * @returns {string[]}
 */
function normalizeApprovedTools(value) {
  const items = value instanceof Set ? Array.from(value) : (Array.isArray(value) ? value : []);
  return Array.from(new Set(items.map((item) => String(item || '').trim()).filter(Boolean))).sort();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toIsoString(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(String(value || ''));
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

/**
 * @param {string} root
 * @param {string} runId
 * @returns {string}
 */
export function getCheckpointPath(root, runId) {
  if (!root || typeof root !== 'string') {
    throw new Error('RunCheckpointer: root is required');
  }
  const id = normalizeRunId(runId);
  return path.join(root, 'checkpoints', `${id}.json`);
}

export class RunCheckpointer {
  /**
   * @param {{ root?: string, now?: () => Date | string }} [options]
   */
  constructor({ root, now = () => new Date() } = {}) {
    if (!root || typeof root !== 'string') {
      throw new Error('RunCheckpointer: root is required');
    }
    this.root = root;
    this.now = now;
  }

  /**
   * @param {CheckpointInput} input
   * @returns {string}
   */
  save(input) {
    const filePath = getCheckpointPath(this.root, input.runId);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    /** @type {RunCheckpoint} */
    const checkpoint = {
      version: 1,
      runId: normalizeRunId(input.runId),
      step: Math.max(0, Math.floor(numberOrZero(input.step))),
      phase: String(input.phase || 'unknown'),
      updatedAt: toIsoString(this.now()),
      messages: cloneArray(input.messages),
      usage: normalizeUsage(input.usage),
      approvedTools: normalizeApprovedTools(input.approvedTools),
      todos: cloneArray(input.todos),
      metadata: cloneObject(input.metadata),
    };
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(tempPath, `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      fs.renameSync(tempPath, filePath);
    } catch (err) {
      try { fs.unlinkSync(tempPath); } catch { /* ignore cleanup failure */ }
      throw err;
    }
    return filePath;
  }

  /**
   * @param {string} runId
   * @returns {RunCheckpoint | null}
   */
  load(runId) {
    const filePath = getCheckpointPath(this.root, runId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return /** @type {RunCheckpoint} */ (JSON.parse(fs.readFileSync(filePath, 'utf8')));
  }

  /**
   * @param {string} runId
   * @returns {boolean}
   */
  clear(runId) {
    const filePath = getCheckpointPath(this.root, runId);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  }
}

/**
 * @param {{ root?: string, now?: () => Date | string }} [options]
 * @returns {RunCheckpointer}
 */
export function createRunCheckpointer(options = {}) {
  return new RunCheckpointer(options);
}
