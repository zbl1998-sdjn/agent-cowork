// Agent 流式聊天输入协议(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:集中校验 /api/agent/chat/stream 进入 Agent 流之前会被本路由消费的请求字段。
import { z } from 'zod';

type RouteError = Error & { statusCode?: number };

const numericLimitSchema = z.union([z.number(), z.string()]);
const requestBudgetSchema = z.object({
  maxRunTokens: numericLimitSchema.optional(),
  maxSessionTokens: numericLimitSchema.optional(),
  maxRunCostUsd: numericLimitSchema.optional(),
  maxSessionCostUsd: numericLimitSchema.optional(),
  maxWallClockMs: numericLimitSchema.optional(),
}).loose();

const contextCompactionSchema = z.object({
  enabled: z.boolean().optional(),
  maxContextTokens: numericLimitSchema.optional(),
  keepRecentMessages: numericLimitSchema.optional(),
  maxFacts: numericLimitSchema.optional(),
}).loose();

export const agentStreamBodySchema = z.object({
  prompt: z.string().optional(),
  conversationId: z.string().optional(),
  resumeRunId: z.string().optional(),
  runSeed: z.union([z.string(), z.number(), z.literal(true)]).optional(),
  seed: z.union([z.string(), z.number(), z.literal(true)]).optional(),
  images: z.array(z.string()).max(12).optional(),
  templateFiles: z.array(z.string().min(1).max(2000)).max(4).optional(),
  permissionMode: z.enum(['plan', 'manual', 'guarded_auto']).optional(),
  autoApprove: z.boolean().optional(),
  background: z.boolean().optional(),
  maxSteps: numericLimitSchema.optional(),
  verify: z.boolean().optional(),
  thinking: z.string().max(64).optional(),
  planMode: z.boolean().optional(),
  developerMode: z.boolean().optional(),
  mode: z.string().max(64).optional(),
  clarifyBeforeModel: z.boolean().optional(),
  autoClarify: z.boolean().optional(),
  contextCompaction: contextCompactionSchema.optional(),
  autoCompactContext: z.boolean().optional(),
  maxContextTokens: numericLimitSchema.optional(),
  keepRecentMessages: numericLimitSchema.optional(),
  maxContextFacts: numericLimitSchema.optional(),
  trustedRoot: z.unknown().optional(),
  modelConfig: z.unknown().optional(),
  kimiConfig: z.unknown().optional(),
  budget: requestBudgetSchema.optional(),
  maxRunTokens: numericLimitSchema.optional(),
  maxSessionTokens: numericLimitSchema.optional(),
  maxRunCostUsd: numericLimitSchema.optional(),
  maxSessionCostUsd: numericLimitSchema.optional(),
  maxWallClockMs: numericLimitSchema.optional(),
}).loose();

export type AgentStreamBody = z.output<typeof agentStreamBodySchema>;

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function inputError(message: string): RouteError {
  const error = new Error(`agent stream body: ${message}`) as RouteError;
  error.statusCode = 400;
  return error;
}

function zodIssueMessage(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

export function parseAgentStreamBody(body: unknown): AgentStreamBody {
  const parsed = agentStreamBodySchema.safeParse(objectOrEmpty(body));
  if (!parsed.success) {
    throw inputError(parsed.error.issues.map(zodIssueMessage).join('; '));
  }
  return parsed.data;
}
