import { sendJson, withJsonBody } from '../http/request-utils.js';
import { listConnectors, suggestConnectors } from '../connectors/catalog.js';
import { handleConnectorOAuthRoutes } from './connector-oauth-routes.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {Error & { statusCode?: number }} RouteError
 * @typedef {{ tenantId?: string, userId?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ name: string, command: string, args: string[] }} ConnectorSpec
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, connectMcp?: (servers: ConnectorSpec[]) => Promise<{ toolCount: number, errors: unknown[] }>, toolRegistry?: any, credentialStore?: any, oauthPermissionApprovals?: any, oauthSessions: Map<string, any>, oauthFetch?: typeof globalThis.fetch, oauthConfig?: any, safeTrustedRoot(input?: unknown): string, fsServerPath?: string }} ConnectorRouteOptions
 */

// Connector catalog routes (suggest + one-click connect).
//   GET  /api/connectors            -> full catalog + currently connected servers
//   GET  /api/connectors/suggest?q= -> keyword-ranked suggestions
//   POST /api/connectors/connect    -> connect a HOST-DEFINED builtin (by id only)
//   POST /api/connectors/oauth/*    -> OAuth device-flow for host-defined providers

// SECURITY (P0): the connect endpoint must NEVER spawn a client-supplied command.
// Allowing `{ command, args }` from the request body is arbitrary program
// execution. This allowlist maps a connector id to a spec whose command is fully
// controlled by the host; request bodies can only pick an id. Other catalog
// entries are `install`-only (the user installs them out-of-band).
/** @param {unknown} id @param {{ fsServerPath?: string, trustedRoot: string }} options @returns {ConnectorSpec | null} */
function buildConnectorSpec(id, { fsServerPath, trustedRoot }) {
  if (id === 'filesystem' && fsServerPath) {
    return { name: 'fs', command: /** @type {string} */ (process.execPath), args: [fsServerPath, trustedRoot] };
  }
  return null;
}

/** @param {unknown} id */
function connectorServerName(id) {
  if (id === 'filesystem') return 'fs';
  return null;
}

/** @param {ConnectorRouteOptions} options */
export async function handleConnectorRoutes({
  request, response, pathname, requestUrl, requestContext,
  connectMcp, toolRegistry, credentialStore, oauthPermissionApprovals, oauthSessions, oauthFetch, oauthConfig,
  safeTrustedRoot, fsServerPath,
}) {
  if (request.method === 'GET' && pathname === '/api/connectors') {
    sendJson(response, 200, {
      context: requestContext,
      connectors: listConnectors(),
      connected: toolRegistry && typeof toolRegistry.mcpServers === 'function' ? toolRegistry.mcpServers() : [],
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/connectors/suggest') {
    const query = requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '';
    const limit = Math.max(1, Math.min(Number(requestUrl.searchParams.get('limit') || 5), 20));
    sendJson(response, 200, { context: requestContext, query, connectors: suggestConnectors(query, { limit }) });
    return true;
  }

  if (pathname.startsWith('/api/connectors/oauth/')) {
    return handleConnectorOAuthRoutes({
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
    });
  }

  if (request.method === 'POST' && pathname === '/api/connectors/connect') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {{ id?: unknown, trustedRoot?: unknown }} */ (body || {});
      if (!connectMcp) {
        sendJson(response, 503, { error: 'MCP connect is not available in this host.' });
        return;
      }
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      // Only host-defined builtins may be spawned; a client-supplied command is
      // rejected outright (no arbitrary program execution via this endpoint).
      const spec = buildConnectorSpec(input.id, { fsServerPath, trustedRoot });
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
          mcpServers: toolRegistry && typeof toolRegistry.mcpServers === 'function' ? toolRegistry.mcpServers() : [],
        });
      } catch (err) {
        const error = /** @type {RouteError} */ (err);
        sendJson(response, error.statusCode || 502, { error: error.message });
      }
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/connectors/disconnect') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {{ id?: unknown }} */ (body || {});
      const name = connectorServerName(input.id);
      if (!name || !toolRegistry || typeof toolRegistry.unregisterMcpServer !== 'function') {
        sendJson(response, 400, { error: 'unsupported connector: only host-defined builtins can be disconnected' });
        return;
      }
      const out = toolRegistry.unregisterMcpServer(name);
      sendJson(response, 200, {
        context: requestContext,
        ...out,
        mcpServers: typeof toolRegistry.mcpServers === 'function' ? toolRegistry.mcpServers() : [],
      });
    });
    return true;
  }

  return false;
}
