// Agent 续跑解析(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:解析 Agent 运行的「起点」——是新建 run 还是从某检查点续跑(resume),并据 seed 构造确定性 ID 源(供回放)。
//       是 agent-stream 的辅助。依赖:L2 run-checkpoint/run-resume/run-store + L0 util/ids。导出:resolveAgentRunStart。
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
