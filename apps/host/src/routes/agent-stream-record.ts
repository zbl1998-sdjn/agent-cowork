// Agent 运行记录(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:把一次 Agent 流式运行收尾落成 run 记录(含配置快照、系统提示词版本)并写入运行索引。
//       记录是诊断路径,失败不能打断主响应。依赖:L2 run-store/runs-index + L1 system-prompt。
import { z } from 'zod';
import { writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { SYSTEM_PROMPT_VERSION } from '../engine/system-prompt.js';
import { buildAgentConfigSnapshot } from './agent-config-snapshot.js';
import { AtRestKeyError } from '../security/at-rest.js';
import { redactValue } from '../security/redaction.js';

export type RunsIndexLike = { upsert(summary: unknown, context?: RequestContext): unknown };
export type RequestContext = { tenantId?: unknown; userId?: unknown; traceId?: unknown; [key: string]: unknown };
export type ModelConfig = Record<string, unknown> & { model?: unknown; provider?: unknown };
export type AgentOutcome = { text?: unknown; steps?: unknown; usage?: unknown };
export type RecordAgentRunOptions = {
  runStoreRoot: string;
  runsIndex: RunsIndexLike;
  requestContext: RequestContext;
  runId: string;
  kimiConfig: ModelConfig;
  body: unknown;
  trustedRoot: string;
  startedAt: Date;
  status: string;
  prompt: unknown;
  outcome: AgentOutcome;
  events: unknown[];
};

const requestContextSchema = z.object({
  tenantId: z.unknown().optional(),
  userId: z.unknown().optional(),
  traceId: z.unknown().optional(),
}).loose();

const modelConfigSchema = z.object({
  model: z.unknown().optional(),
  provider: z.unknown().optional(),
}).loose();

const outcomeSchema = z.object({
  text: z.unknown().optional(),
  steps: z.unknown().optional(),
  usage: z.unknown().optional(),
}).loose();

const recordOptionsSchema = z.object({
  runStoreRoot: z.string(),
  runsIndex: z.custom<RunsIndexLike>(
    (value) => value != null && typeof value === 'object' && typeof (value as { upsert?: unknown }).upsert === 'function',
    { message: 'runsIndex must expose upsert(summary, context)' },
  ),
  requestContext: requestContextSchema,
  runId: z.string().trim().min(1),
  kimiConfig: modelConfigSchema,
  body: z.unknown(),
  trustedRoot: z.string(),
  startedAt: z.instanceof(Date),
  status: z.string().trim().min(1),
  prompt: z.unknown(),
  outcome: outcomeSchema,
  events: z.array(z.unknown()),
}).strict();

function parseRecordOptions(options: unknown): RecordAgentRunOptions | null {
  const result = recordOptionsSchema.safeParse(options);
  return result.success ? result.data : null;
}

function modelProvider(kimiConfig: ModelConfig): string {
  return String(kimiConfig.provider || 'kimi-api').trim().toLowerCase() || 'kimi-api';
}

function safeDiagnosticValue(value: unknown, fallback: unknown): unknown {
  try {
    return redactValue(value);
  } catch {
    return fallback;
  }
}

export function recordAgentRun(options: unknown): void {
  const parsed = parseRecordOptions(options);
  if (!parsed) return;
  const {
    runStoreRoot,
    runsIndex,
    requestContext,
    runId,
    kimiConfig,
    body,
    trustedRoot,
    startedAt,
    status,
    prompt,
    outcome,
    events,
  } = parsed;

  try {
    const finishedAt = new Date();
    const record = {
      id: runId,
      type: 'agent-chat',
      provider: modelProvider(kimiConfig),
      model: kimiConfig.model,
      systemPromptVersion: SYSTEM_PROMPT_VERSION,
      promptBuilder: 'agent-system-prompt',
      configSnapshot: buildAgentConfigSnapshot(body, kimiConfig),
      mode: 'agent',
      trustedRoot,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      status,
      context: requestContext,
      input: { prompt: String(prompt || '') },
      result: {
        ok: status === 'succeeded',
        text: outcome.text,
        steps: safeDiagnosticValue(outcome.steps, [{ error: 'step diagnostics omitted after redaction failure' }]),
        usage: outcome.usage,
      },
      events: safeDiagnosticValue(events, [{ type: 'redaction_failed' }]),
    };
    const runPath = writeRunRecord(runStoreRoot, record);
    runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
  } catch (error) {
    if (error instanceof AtRestKeyError) throw error;
    // 记录仅用于诊断;run 记录或索引失败不能打断主响应。
  }
}
