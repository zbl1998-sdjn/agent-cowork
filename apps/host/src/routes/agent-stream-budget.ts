// Agent 运行预算(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:从请求体/模型配置解析单次 Agent 运行的超时与 token/费用预算,并据此构建预算护栏。
// 依赖:L2 budget-guard。导出:resolveAgentRunTimeoutMs / createAgentBudgetGuard。
import { z } from 'zod';
import { createBudgetGuard } from '../runtime/budget-guard.js';
import { omitUndefined } from '../util/object.js';

type NumericLimit = number | string;
type ModelConfig = {
  model?: string | undefined;
  maxRunTokens?: NumericLimit | undefined;
  maxSessionTokens?: NumericLimit | undefined;
  maxRunCostUsd?: NumericLimit | undefined;
  maxSessionCostUsd?: NumericLimit | undefined;
  maxAgentWallClockMs?: NumericLimit | undefined;
};
type RequestBudget = {
  maxRunTokens?: NumericLimit | undefined;
  maxSessionTokens?: NumericLimit | undefined;
  maxRunCostUsd?: NumericLimit | undefined;
  maxSessionCostUsd?: NumericLimit | undefined;
  maxWallClockMs?: NumericLimit | undefined;
};
type RequestBody = RequestBudget & { budget?: RequestBudget };
type AgentBudgetInputs = { requestBody: RequestBody; config: ModelConfig; requestBudget: RequestBudget };
type RouteError = Error & { statusCode?: number };

export type AgentBudgetGuardOptions = {
  body: unknown;
  kimiConfig: unknown;
  startedAt: Date;
  runTimeoutMs?: number | undefined;
};

const numericLimitSchema = z.union([z.number(), z.string()]);

const requestBudgetSchema = z.object({
  maxRunTokens: numericLimitSchema.optional(),
  maxSessionTokens: numericLimitSchema.optional(),
  maxRunCostUsd: numericLimitSchema.optional(),
  maxSessionCostUsd: numericLimitSchema.optional(),
  maxWallClockMs: numericLimitSchema.optional(),
}).loose();

const requestBodySchema = requestBudgetSchema.extend({
  budget: requestBudgetSchema.optional(),
}).loose();

const modelConfigSchema = z.object({
  model: z.string().optional(),
  maxRunTokens: numericLimitSchema.optional(),
  maxSessionTokens: numericLimitSchema.optional(),
  maxRunCostUsd: numericLimitSchema.optional(),
  maxSessionCostUsd: numericLimitSchema.optional(),
  maxAgentWallClockMs: numericLimitSchema.optional(),
}).loose();

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function inputError(message: string): RouteError {
  const error = new Error(`agent stream budget: ${message}`) as RouteError;
  error.statusCode = 400;
  return error;
}

function zodIssueMessage(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

function parseSchema<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw inputError(result.error.issues.map(zodIssueMessage).join('; '));
  }
  return result.data;
}

function positiveLimit(value: NumericLimit | undefined): number | null {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function tightestLimit(configValue: NumericLimit | undefined, requestValue: NumericLimit | undefined): number | undefined {
  const fromConfig = positiveLimit(configValue);
  const fromRequest = positiveLimit(requestValue);
  if (fromConfig !== null && fromRequest !== null) return Math.min(fromConfig, fromRequest);
  return fromConfig ?? fromRequest ?? undefined;
}

function budgetInputs(body: unknown, kimiConfig: unknown): AgentBudgetInputs {
  const requestBody = omitUndefined(parseSchema(requestBodySchema, objectOrEmpty(body))) as RequestBody;
  const config = omitUndefined(parseSchema(modelConfigSchema, objectOrEmpty(kimiConfig))) as ModelConfig;
  return { requestBody, config, requestBudget: requestBody.budget ?? {} };
}

export function resolveAgentRunTimeoutMs(body: unknown, kimiConfig: unknown): number | undefined {
  const { requestBody, config, requestBudget } = budgetInputs(body, kimiConfig);
  return tightestLimit(config.maxAgentWallClockMs, requestBudget.maxWallClockMs ?? requestBody.maxWallClockMs);
}

export function createAgentBudgetGuard({
  body,
  kimiConfig,
  startedAt,
  runTimeoutMs,
}: AgentBudgetGuardOptions): ReturnType<typeof createBudgetGuard> {
  const { requestBody, config, requestBudget } = budgetInputs(body, kimiConfig);
  return createBudgetGuard(omitUndefined({
    maxRunTokens: tightestLimit(config.maxRunTokens, requestBudget.maxRunTokens ?? requestBody.maxRunTokens),
    maxSessionTokens: tightestLimit(config.maxSessionTokens, requestBudget.maxSessionTokens ?? requestBody.maxSessionTokens),
    maxRunCostUsd: tightestLimit(config.maxRunCostUsd, requestBudget.maxRunCostUsd ?? requestBody.maxRunCostUsd),
    maxSessionCostUsd: tightestLimit(config.maxSessionCostUsd, requestBudget.maxSessionCostUsd ?? requestBody.maxSessionCostUsd),
    maxWallClockMs: runTimeoutMs,
    model: config.model,
    startedAtMs: startedAt.getTime(),
  }));
}
