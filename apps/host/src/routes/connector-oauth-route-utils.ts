// 连接器 OAuth 路由·工具(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:connector-oauth-routes 用到的纯工具——识别 GitHub、取客户端 id、由请求上下文构造
//       凭据身份/过滤器、归一化错误状态码与消息。依赖:L1 connectors/catalog。
import { z } from 'zod';
import { getConnector } from '../connectors/catalog.js';
import { omitUndefined } from '../util/object.js';
import type { ConnectorDescriptor } from '../connectors/catalog.js';

export const GITHUB_CLIENT_ID_ENV_KEYS = Object.freeze(['KCW_GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_ID']);

export type RequestContext = {
  tenantId?: string;
  userId?: string;
  [key: string]: unknown;
};
export type OAuthIdentity = {
  tenantId?: string;
  userId?: string;
  provider: string;
  accountId: string;
};
export type OAuthFilter = Omit<OAuthIdentity, 'accountId'>;

type RouteError = Error & { statusCode?: number };

const optionalStringField = z.preprocess(
  (value) => (typeof value === 'string' ? value : undefined),
  z.string().optional(),
);

const requestContextSchema = z.object({
  tenantId: optionalStringField,
  userId: optionalStringField,
}).passthrough();

const oauthConfigSchema = z.object({
  github: z.object({
    clientId: optionalStringField,
  }).passthrough().optional(),
}).passthrough();

const providerSchema = z.string().trim().min(1, 'provider is required');
const accountIdSchema = z.string().trim().min(1, 'accountId is required');
const routeErrorSchema = z.object({
  statusCode: z.number().int().min(100).max(599).optional(),
}).passthrough();

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requestContext(value: unknown): RequestContext {
  const result = requestContextSchema.safeParse(objectOrEmpty(value));
  return result.success ? omitUndefined(result.data) : {};
}

export function isGitHub(id: unknown): boolean {
  return String(id || '').toLowerCase() === 'github';
}

export function githubClientId(oauthConfig?: unknown): string {
  const result = oauthConfigSchema.safeParse(objectOrEmpty(oauthConfig));
  const configClientId = result.success ? result.data.github?.clientId : '';
  return String(
    configClientId
      || process.env.KCW_GITHUB_OAUTH_CLIENT_ID
      || process.env.GITHUB_OAUTH_CLIENT_ID
      || '',
  ).trim();
}

export function oauthIdentity(requestContextInput: RequestContext, providerInput: string, accountIdInput = 'default'): OAuthIdentity {
  const context = requestContext(requestContextInput);
  return omitUndefined({
    tenantId: context.tenantId,
    userId: context.userId,
    provider: providerSchema.parse(providerInput),
    accountId: accountIdSchema.parse(accountIdInput),
  });
}

export function oauthFilter(requestContextInput: RequestContext, providerInput: string): OAuthFilter {
  const context = requestContext(requestContextInput);
  return omitUndefined({
    tenantId: context.tenantId,
    userId: context.userId,
    provider: providerSchema.parse(providerInput),
  });
}

export function githubConnector(): ConnectorDescriptor {
  const connector = getConnector('github');
  if (!connector) {
    const err = new Error('GitHub connector is not registered') as RouteError;
    err.statusCode = 500;
    throw err;
  }
  return connector;
}

export function errorStatus(err: unknown, fallback: number): number {
  const result = routeErrorSchema.safeParse(objectOrEmpty(err));
  if (result.success && typeof result.data.statusCode === 'number') return result.data.statusCode;
  return Number.isInteger(fallback) && fallback >= 100 && fallback <= 599 ? fallback : 500;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
