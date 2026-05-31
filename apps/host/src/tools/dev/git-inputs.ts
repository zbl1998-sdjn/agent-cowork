// Git 工具输入 schema(host · L1 领域层 · tools/dev)
// ---------------------------------------------------------------------------
// 职责:集中校验 Git 工具外部入参。所有 schema 都是 strict,未知字段会在进入
//       path jail 与命令执行前失败。
import { z } from 'zod';

export type GitStatusArgs = { workspace?: string; short?: boolean; branch?: boolean };
export type GitDiffArgs = { workspace?: string; path?: string; staged?: boolean; stat?: boolean; context?: number };
export type GitLogArgs = { workspace?: string; maxCount?: number; path?: string };
export type GitWriteArgs = { workspace?: string; message: string; all?: boolean; paths?: string[] };

const gitStatusArgsSchema = z.object({
  workspace: z.string().optional(),
  short: z.boolean().optional(),
  branch: z.boolean().optional(),
}).strict();

const gitDiffArgsSchema = z.object({
  workspace: z.string().optional(),
  path: z.string().min(1).optional(),
  staged: z.boolean().optional(),
  stat: z.boolean().optional(),
  context: z.number().finite().optional(),
}).strict();

const gitLogArgsSchema = z.object({
  workspace: z.string().optional(),
  maxCount: z.number().finite().optional(),
  path: z.string().min(1).optional(),
}).strict();

const gitWriteArgsSchema = z.object({
  workspace: z.string().optional(),
  message: z.string().trim().min(1, 'message is required').max(500, 'message is too long'),
  all: z.boolean().optional(),
  paths: z.array(z.string().min(1)).max(100, 'too many paths').optional(),
}).strict();

function inputError(toolName: string, message: string): Error & { statusCode?: number } {
  const error = new Error(`${toolName}: ${message}`) as Error & { statusCode?: number };
  error.statusCode = 400;
  return error;
}

function zodIssueMessage(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

function parseArgs<T>(toolName: string, schema: z.ZodType<T>, args: unknown): T {
  const result = schema.safeParse(args ?? {});
  if (!result.success) {
    throw inputError(toolName, result.error.issues.map(zodIssueMessage).join('; '));
  }
  return result.data;
}

export function parseGitStatusArgs(args: unknown): GitStatusArgs {
  return parseArgs('git.status', gitStatusArgsSchema, args);
}

export function parseGitDiffArgs(args: unknown): GitDiffArgs {
  return parseArgs('git.diff', gitDiffArgsSchema, args);
}

export function parseGitLogArgs(args: unknown): GitLogArgs {
  return parseArgs('git.log', gitLogArgsSchema, args);
}

export function parseGitWriteArgs(toolName: string, args: unknown): GitWriteArgs {
  return parseArgs(toolName, gitWriteArgsSchema, args);
}
