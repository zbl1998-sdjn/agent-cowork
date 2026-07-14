// 连接器 OAuth 路由·工具(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:connector-oauth-routes 用到的纯工具——识别 GitHub、取客户端 id、由请求上下文构造
//       凭据身份/过滤器、归一化错误状态码与消息。依赖:L1 connectors/catalog。
import { z } from 'zod';
import { getConnector } from '../connectors/catalog.js';
import {
  canonicalCredentialAccountId,
  canonicalCredentialProvider,
} from '../security/credential-identity.js';
import { requireIdentityScopeFrom } from '../security/identity-scope.js';
import { readCompatEnv } from '../util/env-compat.js';
import type { ConnectorDescriptor } from '../connectors/catalog.js';

export const GITHUB_CLIENT_ID_ENV_KEYS = Object.freeze(['ACW_GITHUB_OAUTH_CLIENT_ID', 'KCW_GITHUB_OAUTH_CLIENT_ID', 'GITHUB_OAUTH_CLIENT_ID']);

export type RequestContext = {
  tenantId?: string;
  userId?: string;
  [key: string]: unknown;
};
export type OAuthIdentity = {
  tenantId: string;
  userId: string;
  provider: string;
  accountId: string;
};
export type OAuthFilter = Omit<OAuthIdentity, 'accountId'>;

type RouteError = Error & { statusCode?: number };

const optionalStringField = z.preprocess(
  (value) => (typeof value === 'string' ? value : undefined),
  z.string().optional(),
);

const oauthConfigSchema = z.object({
  github: z.object({
    clientId: optionalStringField,
  }).loose().optional(),
}).loose();

const routeErrorSchema = z.object({
  statusCode: z.number().int().min(100).max(599).optional(),
}).loose();

function objectOrEmpty(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function isGitHub(id: unknown): boolean {
  return String(id || '').toLowerCase() === 'github';
}

export function githubClientId(oauthConfig?: unknown): string {
  const result = oauthConfigSchema.safeParse(objectOrEmpty(oauthConfig));
  const configClientId = result.success ? result.data.github?.clientId : '';
  return String(
    configClientId
      || readCompatEnv(process.env, 'ACW_GITHUB_OAUTH_CLIENT_ID', 'KCW_GITHUB_OAUTH_CLIENT_ID')
      || process.env.GITHUB_OAUTH_CLIENT_ID
      || '',
  ).trim();
}

export function oauthIdentity(requestContextInput: RequestContext, providerInput: string, accountIdInput = 'default'): OAuthIdentity {
  const owner = requireIdentityScopeFrom(requestContextInput, { label: 'OAuth request identity' });
  return {
    ...owner,
    provider: canonicalCredentialProvider(providerInput),
    accountId: canonicalCredentialAccountId(accountIdInput),
  };
}

export function oauthFilter(requestContextInput: RequestContext, providerInput: string): OAuthFilter {
  const owner = requireIdentityScopeFrom(requestContextInput, { label: 'OAuth request identity' });
  return { ...owner, provider: canonicalCredentialProvider(providerInput) };
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
