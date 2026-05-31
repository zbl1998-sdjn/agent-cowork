// Web 工具输入 schema(host · L1 领域层 · tools)
// ---------------------------------------------------------------------------
// 职责:用 zod 在联网工具边界校验外部参数,确保未知字段/错误类型在触发网络前失败。
import { z } from 'zod';

export type WebFetchError = Error & { statusCode?: number };
export type WebFetchResponse = {
  ok?: boolean;
  status?: number;
  headers?: { get(name: string): string | null } | null;
  arrayBuffer(): Promise<ArrayBuffer> | ArrayBuffer;
};
export type WebFetchLike = (
  input: string,
  init: { signal: AbortSignal; redirect: 'manual' },
) => Promise<WebFetchResponse> | WebFetchResponse;
export type WebFetchOptions = {
  url?: unknown;
  timeoutMs?: unknown;
  maxBytes?: unknown;
  allowInternal?: boolean;
  fetchImpl?: WebFetchLike;
  lookupImpl?: (host: string) => Promise<unknown> | unknown;
};

export type WebSearchError = Error & { statusCode?: number };
export type WebSearchResponseLike = {
  ok?: boolean;
  status?: number;
  text(): Promise<string> | string;
};
export type WebSearchFetchLike = (
  input: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<WebSearchResponseLike> | WebSearchResponseLike;
export type WebSearchOptions = {
  query?: unknown;
  maxResults?: unknown;
  provider?: unknown;
  allowInternal?: boolean;
  fetchImpl?: WebSearchFetchLike;
  lookupImpl?: (host: string) => Promise<unknown> | unknown;
  timeoutMs?: number;
};
export type ParsedWebSearchOptions = WebSearchOptions & { query: string; provider: string };

const optionalFunction = z.custom<((...args: unknown[]) => unknown) | undefined>(
  (value) => value === undefined || typeof value === 'function',
  { message: 'must be a function' },
);

const webFetchOptionsSchema = z.object({
  url: z.unknown().optional(),
  timeoutMs: z.unknown().optional(),
  maxBytes: z.unknown().optional(),
  allowInternal: z.boolean().optional(),
  fetchImpl: optionalFunction.optional(),
  lookupImpl: optionalFunction.optional(),
}).strict();

const webSearchOptionsSchema = z.object({
  query: z.preprocess(
    (value) => (typeof value === 'string' ? value.trim() : ''),
    z.string().min(1, 'query is required').max(400, 'query too long (max 400 chars)'),
  ),
  maxResults: z.unknown().optional(),
  provider: z.preprocess(
    (value) => (typeof value === 'string' && value ? value : 'ddg'),
    z.string(),
  ),
  allowInternal: z.boolean().optional(),
  fetchImpl: optionalFunction.optional(),
  lookupImpl: optionalFunction.optional(),
  timeoutMs: z.number().positive().finite().optional(),
}).strict();

function inputError(prefix: 'web.fetch' | 'web.search', message: string): WebFetchError | WebSearchError {
  const error = new Error(`${prefix}: ${message}`) as WebFetchError | WebSearchError;
  error.statusCode = 400;
  return error;
}

function zodIssueMessage(issue: z.core.$ZodIssue): string {
  const field = issue.path.length ? `${issue.path.join('.')}: ` : '';
  return `${field}${issue.message}`;
}

/** 校验 web.fetch 外部参数,未知字段或错误类型会在网络请求前失败。 */
export function parseWebFetchOptions(options: WebFetchOptions): WebFetchOptions {
  const result = webFetchOptionsSchema.safeParse(options);
  if (!result.success) {
    throw inputError('web.fetch', result.error.issues.map(zodIssueMessage).join('; '));
  }
  return result.data as WebFetchOptions;
}

/** 校验 web.search 外部参数,同时把 query trim、默认 provider 收口成确定字符串。 */
export function parseWebSearchOptions(options: WebSearchOptions): ParsedWebSearchOptions {
  const result = webSearchOptionsSchema.safeParse(options);
  if (!result.success) {
    throw inputError('web.search', result.error.issues.map(zodIssueMessage).join('; '));
  }
  return result.data as ParsedWebSearchOptions;
}
