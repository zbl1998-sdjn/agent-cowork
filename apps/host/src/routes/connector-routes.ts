// 连接器路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/connectors/* —— 列出/按关键词建议连接器、接入或吊销 MCP 连接器并导入其工具。
// 依赖:L0 request-utils + L1 connectors/mcp + L1 tools 注册表(经参数注入)。导出:handleConnectorRoutes。
import { z } from 'zod';
import { sendJson, withJsonBody } from '../http/request-utils.js';
import { listConnectors, suggestConnectors } from '../connectors/catalog.js';
import { omitUndefined } from '../util/object.js';
import { handleConnectorOAuthRoutes } from './connector-oauth-routes.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { CredentialStore } from '../security/credential-store.js';
import type { OAuthPermissionApprovalStore } from '../runtime/oauth-permission-approvals.js';
import type { ConnectorOAuthSession } from './connector-oauth-session.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number };
type RequestContext = { tenantId?: string; userId?: string; [key: string]: unknown };
type ConnectorSpec = { name: string; command: string; args: string[] };
type ConnectMcpResult = { toolCount: number; errors: unknown[] };
type ToolRegistryLike = {
  mcpServers?: () => string[];
  unregisterMcpServer?: (name: string) => Record<string, unknown>;
};
type ConnectorRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  connectMcp?: (servers: ConnectorSpec[]) => Promise<ConnectMcpResult>;
  toolRegistry?: ToolRegistryLike | null;
  credentialStore?: CredentialStore;
  oauthPermissionApprovals?: OAuthPermissionApprovalStore;
  oauthSessions: Map<string, ConnectorOAuthSession>;
  oauthFetch?: typeof globalThis.fetch;
  oauthConfig?: { github?: { clientId?: unknown } };
  safeTrustedRoot(input?: unknown): string;
  fsServerPath?: string;
  fsServerRunnerPath?: string;
};

const connectorIdPattern = /^[a-z0-9_-]{1,64}$/;
const connectorIdSchema = z.string().trim().regex(connectorIdPattern, 'connector id is invalid');
const suggestQuerySchema = z.object({
  q: z.string().optional(),
  query: z.string().optional(),
  limit: z.coerce.number().int().catch(5),
}).loose();
const connectBodySchema = z.object({
  id: connectorIdSchema.optional(),
  trustedRoot: z.unknown().optional(),
}).loose();
const disconnectBodySchema = z.object({
  id: connectorIdSchema,
}).loose();

function errorStatus(err: unknown, fallback: number): number {
  return err && typeof err === 'object' && 'statusCode' in err && typeof (err as RouteError).statusCode === 'number'
    ? (err as RouteError).statusCode ?? fallback
    : fallback;
}

function errorMessage(err: unknown, fallback = 'invalid connector request'): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message || fallback;
  return err instanceof Error ? err.message : String(err);
}

function connectedServers(toolRegistry?: ToolRegistryLike | null): string[] {
  return toolRegistry && typeof toolRegistry.mcpServers === 'function' ? toolRegistry.mcpServers() : [];
}

// 安全边界:绝不执行客户端传入的命令;请求体只能选择 host 内置 id,command/args 完全由 allowlist 控制。
function buildConnectorSpec(
  id: unknown,
  { fsServerPath, fsServerRunnerPath, trustedRoot }: { fsServerPath?: string; fsServerRunnerPath?: string; trustedRoot: string },
): ConnectorSpec | null {
  const nodePath = typeof process.execPath === 'string' && process.execPath ? process.execPath : undefined;
  if (id === 'filesystem' && fsServerPath && fsServerRunnerPath && nodePath) {
    return { name: 'fs', command: nodePath, args: [fsServerRunnerPath, fsServerPath, trustedRoot] };
  }
  return null;
}

function connectorServerName(id: unknown): string | null {
  if (id === 'filesystem') return 'fs';
  return null;
}

export async function handleConnectorRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  connectMcp,
  toolRegistry,
  credentialStore,
  oauthPermissionApprovals,
  oauthSessions,
  oauthFetch,
  oauthConfig,
  safeTrustedRoot,
  fsServerPath,
  fsServerRunnerPath,
}: ConnectorRouteOptions): Promise<boolean> {
  if (request.method === 'GET' && pathname === '/api/connectors') {
    sendJson(response, 200, {
      context: requestContext,
      connectors: listConnectors(),
      connected: connectedServers(toolRegistry),
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/connectors/suggest') {
    const queryParams = suggestQuerySchema.parse(Object.fromEntries(requestUrl.searchParams.entries()));
    const query = queryParams.q || queryParams.query || '';
    const limit = Math.max(1, Math.min(queryParams.limit, 20));
    sendJson(response, 200, { context: requestContext, query, connectors: suggestConnectors(query, { limit }) });
    return true;
  }

  if (pathname.startsWith('/api/connectors/oauth/')) {
    return handleConnectorOAuthRoutes(omitUndefined({
      request,
      response,
      pathname,
      requestUrl,
      requestContext,
      credentialStore,
      oauthPermissionApprovals,
      oauthSessions,
      oauthFetch,
      oauthConfig,
    }));
  }

  if (request.method === 'POST' && pathname === '/api/connectors/connect') {
    await withJsonBody(request, response, async (body) => {
      const parsed = connectBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      const input = parsed.data;
      if (!connectMcp) {
        sendJson(response, 503, { error: 'MCP connect is not available in this host.' });
        return;
      }
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      const spec = buildConnectorSpec(input.id, omitUndefined({ fsServerPath, fsServerRunnerPath, trustedRoot }));
      if (!spec) {
        sendJson(response, 400, { error: 'unsupported connector: only host-defined builtins can be connected (client-supplied commands are not allowed)' });
        return;
      }
      try {
        const out = await connectMcp([spec]);
        sendJson(response, 200, {
          context: requestContext,
          name: spec.name,
          connected: out.toolCount,
          errors: out.errors,
          mcpServers: connectedServers(toolRegistry),
        });
      } catch (err) {
        sendJson(response, errorStatus(err, 502), { error: errorMessage(err) });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/disconnect') {
    await withJsonBody(request, response, async (body) => {
      const parsed = disconnectBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      const name = connectorServerName(parsed.data.id);
      if (!name || !toolRegistry || typeof toolRegistry.unregisterMcpServer !== 'function') {
        sendJson(response, 400, { error: 'unsupported connector: only host-defined builtins can be disconnected' });
        return;
      }
      const out = toolRegistry.unregisterMcpServer(name);
      sendJson(response, 200, {
        context: requestContext,
        ...out,
        mcpServers: connectedServers(toolRegistry),
      });
    });
    return true;
  }

  return false;
}
