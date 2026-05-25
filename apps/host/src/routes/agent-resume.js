// @ts-check

import { createRunCheckpointer } from '../runtime/run-checkpoint.js';
import { createRunResumer } from '../runtime/run-resume.js';
import { createRunId } from '../runtime/run-store.js';
import { createSeededIdSource } from '../util/ids.js';

/**
 * @param {Record<string, unknown> | null | undefined} body
 * @returns {{ runId: string, startedAt: Date, resumed: boolean }}
 */
function createAgentRunIdentity(body) {
  const resumeRunId = typeof body?.resumeRunId === 'string' ? body.resumeRunId.trim() : '';
  if (resumeRunId) {
    return { runId: resumeRunId, startedAt: new Date(), resumed: true };
  }
  const seed = body && (body.runSeed || body.seed);
  if (!seed) {
    const startedAt = new Date();
    return { runId: createRunId(startedAt), startedAt, resumed: false };
  }
  const ids = createSeededIdSource(seed);
  const startedAt = ids.date();
  return { runId: createRunId(startedAt, { randomHex: ids.randomHex }), startedAt, resumed: false };
}

/**
 * @param {{ body?: Record<string, unknown> | null, runStoreRoot?: string | null }} options
 */
export function resolveAgentRunStart({ body, runStoreRoot }) {
  const identity = createAgentRunIdentity(body);
  const checkpointer = runStoreRoot ? createRunCheckpointer({ root: runStoreRoot }) : null;
  const resumeState = identity.resumed && checkpointer
    ? createRunResumer({ checkpointer }).load(identity.runId)
    : null;
  return { ...identity, checkpointer, resumeState };
}
