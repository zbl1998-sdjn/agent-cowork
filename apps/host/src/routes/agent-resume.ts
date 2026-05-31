// Agent 续跑解析(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:解析 Agent 运行的「起点」——是新建 run 还是从某检查点续跑(resume),并据 seed 构造确定性 ID 源(供回放)。
//       是 agent-stream 的辅助。依赖:L2 run-checkpoint/run-resume/run-store + L0 util/ids。导出:resolveAgentRunStart。
import { z } from 'zod';
import { createRunCheckpointer } from '../runtime/run-checkpoint.js';
import { createRunResumer } from '../runtime/run-resume.js';
import { createRunId } from '../runtime/run-store.js';
import { createSeededIdSource } from '../util/ids.js';

type RunCheckpointer = ReturnType<typeof createRunCheckpointer>;
type RunResumer = ReturnType<typeof createRunResumer>;
type ResumeState = ReturnType<RunResumer['load']>;
type AgentRunIdentity = { runId: string; startedAt: Date; resumed: boolean };
type AgentRunStartBody = { resumeRunId?: string; runSeed?: string | number | true; seed?: string | number | true };
type AgentRunStartOptions = { body?: Record<string, unknown> | null; runStoreRoot?: string | null };
export type AgentRunStart = AgentRunIdentity & { checkpointer: RunCheckpointer | null; resumeState: ResumeState };

const optionalTrimmedString = z.preprocess((value) => {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return text || undefined;
}, z.string().optional());

const optionalSeed = z.preprocess((value) => {
  if (typeof value === 'string') {
    const text = value.trim();
    return text || undefined;
  }
  if (typeof value === 'number' && Number.isFinite(value) && value !== 0) return value;
  if (value === true) return value;
  return undefined;
}, z.union([z.string(), z.number(), z.literal(true)]).optional());

const agentRunStartBodySchema = z.preprocess(
  (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {}),
  z.object({
    resumeRunId: optionalTrimmedString,
    runSeed: optionalSeed,
    seed: optionalSeed,
  }),
);

function normalizeAgentRunStartBody(body: unknown): AgentRunStartBody {
  return agentRunStartBodySchema.parse(body);
}

function createAgentRunIdentity(body: AgentRunStartBody): AgentRunIdentity {
  if (body.resumeRunId) {
    return { runId: body.resumeRunId, startedAt: new Date(), resumed: true };
  }
  const seed = body.runSeed ?? body.seed;
  if (!seed) {
    const startedAt = new Date();
    return { runId: createRunId(startedAt), startedAt, resumed: false };
  }
  const ids = createSeededIdSource(seed);
  const startedAt = ids.date();
  return { runId: createRunId(startedAt, { randomHex: ids.randomHex }), startedAt, resumed: false };
}

export function resolveAgentRunStart({ body, runStoreRoot }: AgentRunStartOptions): AgentRunStart {
  const identity = createAgentRunIdentity(normalizeAgentRunStartBody(body));
  const checkpointer = runStoreRoot ? createRunCheckpointer({ root: runStoreRoot }) : null;
  const resumeState = identity.resumed && checkpointer
    ? createRunResumer({ checkpointer }).load(identity.runId)
    : null;
  return { ...identity, checkpointer, resumeState };
}
