// 内置工具组装入参 schema(host · L1 领域层)
// ---------------------------------------------------------------------------
// 职责:校验 createBuiltinTools 的依赖注入参数,并提供 handler 常用的 args/context 解析。
import { z } from 'zod';
import type { RunEventsLike, RunsIndexLike, SandboxLike } from '../sandbox/code-runner-types.js';
import type { SandboxLimits } from '../sandbox/sandbox-spec.js';
import type { WebFetchLike } from './web-fetch.js';
import type { WebSearchFetchLike } from './web-search.js';

export type ToolContext = { trustedRoot?: string; context?: Record<string, unknown> };
export type ArgsRecord = Record<string, unknown>;
export type BuiltinToolsOptions = {
  sandbox?: SandboxLike | null;
  sandboxLimits?: SandboxLimits;
  runStoreRoot?: string;
  runEvents?: RunEventsLike | null;
  runsIndex?: RunsIndexLike | null;
  enableWebTools?: boolean;
  fetchImpl?: WebFetchLike | WebSearchFetchLike;
  // 联网工具(web.fetch/WebSearch)出站策略检查用:取「当前」安全模式,不是装配时的快照——
  // 传引用而非值,因为 securityMode 所在的配置对象可能在运行期被路由原地更新。
  resolveSecurityMode?: () => unknown;
};
export type BuiltinToolsOptionsInput = {
  sandbox?: unknown;
  sandboxLimits?: unknown;
  runStoreRoot?: unknown;
  runEvents?: unknown;
  runsIndex?: unknown;
  enableWebTools?: unknown;
  fetchImpl?: unknown;
  resolveSecurityMode?: unknown;
};

const sandboxSchema = z.custom<SandboxLike | null | undefined>(
  (value) => value == null || (typeof value === 'object' && typeof (value as { exec?: unknown }).exec === 'function'),
  { message: 'sandbox must expose exec(spec, ctx)' },
);

const builtinToolsOptionsSchema = z.object({
  sandbox: sandboxSchema.optional(),
  sandboxLimits: z.unknown().optional(),
  runStoreRoot: z.string().optional(),
  runEvents: z.unknown().nullable().optional(),
  runsIndex: z.unknown().nullable().optional(),
  enableWebTools: z.boolean().optional(),
  fetchImpl: z.custom<WebFetchLike | WebSearchFetchLike | undefined>(
    (value) => value === undefined || typeof value === 'function',
    { message: 'fetchImpl must be a function' },
  ).optional(),
  resolveSecurityMode: z.custom<(() => unknown) | undefined>(
    (value) => value === undefined || typeof value === 'function',
    { message: 'resolveSecurityMode must be a function' },
  ).optional(),
}).strict();

function inputError(message: string): Error & { statusCode?: number } {
  const error = new Error(`createBuiltinTools: ${message}`) as Error & { statusCode?: number };
  error.statusCode = 400;
  return error;
}

function zodIssueMessage(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

export function parseBuiltinToolsOptions(options: unknown): BuiltinToolsOptions {
  const result = builtinToolsOptionsSchema.safeParse(options ?? {});
  if (!result.success) {
    throw inputError(result.error.issues.map(zodIssueMessage).join('; '));
  }
  return result.data as BuiltinToolsOptions;
}

export function argsRecord(args: unknown): ArgsRecord {
  return args && typeof args === 'object' && !Array.isArray(args) ? args as ArgsRecord : {};
}

export function contextRecord(ctx: unknown): ToolContext {
  return ctx && typeof ctx === 'object' ? ctx as ToolContext : {};
}
