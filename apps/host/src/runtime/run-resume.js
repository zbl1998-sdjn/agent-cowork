// @ts-check

import { createRunCheckpointer } from './run-checkpoint.js';

/**
 * @typedef {{
 *   runId: string,
 *   step: number,
 *   phase: string,
 *   messages: unknown[],
 *   usage: { prompt_tokens: number, completion_tokens: number, total_tokens: number },
 *   approvedTools: string[],
 *   todos: unknown[],
 *   metadata: Record<string, unknown>,
 *   checkpoint: unknown,
 * }} ResumeState
 */

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function jsonClone(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function objectOrEmpty(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {{ prompt_tokens: number, completion_tokens: number, total_tokens: number }}
 */
function usageOrZero(value) {
  const usage = objectOrEmpty(value);
  return {
    prompt_tokens: Number(usage.prompt_tokens || 0),
    completion_tokens: Number(usage.completion_tokens || 0),
    total_tokens: Number(usage.total_tokens || 0),
  };
}

/**
 * @param {unknown} checkpoint
 * @returns {ResumeState}
 */
export function resumeStateFromCheckpoint(checkpoint) {
  const record = objectOrEmpty(checkpoint);
  const runId = String(record.runId || '').trim();
  if (!runId) {
    throw new Error('run-resume: checkpoint runId is required');
  }
  const metadata = objectOrEmpty(record.metadata);
  return {
    runId,
    step: Math.max(0, Math.floor(Number(record.step || 0))),
    phase: String(record.phase || 'unknown'),
    messages: Array.isArray(record.messages) ? /** @type {unknown[]} */ (jsonClone(record.messages)) : [],
    usage: usageOrZero(record.usage),
    approvedTools: Array.isArray(record.approvedTools) ? record.approvedTools.map((item) => String(item)) : [],
    todos: Array.isArray(record.todos) ? /** @type {unknown[]} */ (jsonClone(record.todos)) : [],
    metadata: /** @type {Record<string, unknown>} */ (jsonClone(metadata)),
    checkpoint: jsonClone(record),
  };
}

export class RunResumer {
  /**
   * @param {{ root?: string, checkpointer?: { load(runId: string): unknown } }} [options]
   */
  constructor(options = {}) {
    const { root, checkpointer } = options;
    const resolvedCheckpointer = checkpointer || (root ? createRunCheckpointer({ root }) : null);
    if (!resolvedCheckpointer) {
      throw new Error('RunResumer: root or checkpointer is required');
    }
    this.checkpointer = resolvedCheckpointer;
  }

  /**
   * @param {string} runId
   * @returns {ResumeState | null}
   */
  load(runId) {
    const checkpoint = this.checkpointer.load(runId);
    return checkpoint ? resumeStateFromCheckpoint(checkpoint) : null;
  }
}

/**
 * @param {{ root?: string, checkpointer?: { load(runId: string): unknown } }} [options]
 * @returns {RunResumer}
 */
export function createRunResumer(options = {}) {
  return new RunResumer(options);
}
