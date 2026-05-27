import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRequestIdentity } from './auth/request-identity.js';
import { applyRequestMiddleware } from './http/middleware/common.js';
import { createRequestContext, sendJson } from './http/request-utils.js';
import { createStaticResponder } from './http/static-assets.js';
import { connectMcpServers, closeMcpClients } from './mcp/connect.js';
import { handleRouteChain } from './routes/route-chain.js';
import { createHostState } from './runtime/host-state.js';
import { redactText } from './security/redaction.js';

// @ts-check

const hostSrcDir = path.dirname(fileURLToPath(import.meta.url));

/**
 * @typedef {import('./mcp/connect.js').McpServerSpec} McpServerSpec
 * @typedef {import('./mcp/connect.js').ConnectedMcpClient} ConnectedMcpClient
 * @typedef {{ [key: string]: any, mcpServers?: McpServerSpec[], connectMcpOnStart?: boolean }} ServerConfig
 * @typedef {import('node:http').Server & { toolRegistry?: unknown, _mcpClients: ConnectedMcpClient[], connectMcpServers(servers?: McpServerSpec[]): Promise<unknown>, closeMcp(): void, isDraining(): boolean, shutdown(options?: { timeoutMs?: number }): Promise<void> }} HostServer
 */

/** @param {ServerConfig} [config] @returns {HostServer} */
export function createServer(config = {}) {
  const state = createHostState(config, { hostSrcDir });
  const serveStatic = createStaticResponder({
    staticRoot: state.staticRoot,
    uiDistRoot: state.uiDistRoot,
    uiDistEnabled: state.uiDistEnabled,
  });

  const server = /** @type {HostServer} */ (http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;
      const requestContext = createRequestContext(request);
      attachRequestIdentity({
        request,
        requestContext,
        authStore: state.authStore,
        jwtSecret: state.jwtSecret,
        trustIdentityHeaders: state.trustIdentityHeaders,
      });
      if (applyRequestMiddleware({
        request,
        response,
        pathname,
        requestContext,
        rateLimiter: state.rateLimiter,
        requireAuth: state.requireAuth,
        validateHost: state.validateHost,
      })) {
        return;
      }
      if (serveStatic(request, response, pathname)) {
        return;
      }
      if (await handleRouteChain({ request, response, pathname, requestUrl, requestContext, state, server })) {
        return;
      }
      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      try {
        const errorText = err instanceof Error ? (err.stack || err.message) : String(err);
        console.error('[host] unhandled request error:', redactText(errorText));
      } catch {
        /* ignore */
      }
      sendJson(response, 500, { error: 'internal server error' });
    }
  }));

  server.toolRegistry = state.toolRegistry;
  server._mcpClients = [];
  server.connectMcpServers = async (servers = []) => {
    const outcome = await connectMcpServers({ registry: state.toolRegistry, servers, spawn: config.mcpSpawn });
    server._mcpClients.push(...outcome.clients);
    return outcome;
  };
  server.closeMcp = () => {
    closeMcpClients(server._mcpClients);
    server._mcpClients = [];
  };

  server.isDraining = () => state.draining;
  server.shutdown = async ({ timeoutMs = 10000 } = {}) => {
    state.draining = true;
    try { state.cancellation.cancelAll('shutdown'); } catch { /* ignore */ }
    try { state.approvalRegistry.cancelAll('reject'); } catch { /* ignore */ }
    try { server.closeMcp(); } catch { /* ignore */ }
    try {
      if (state.activeScheduler && typeof state.activeScheduler.stop === 'function') state.activeScheduler.stop();
    } catch {
      /* ignore */
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {
        /* ignore */
      }
      server.close(() => { clearTimeout(timer); resolve(undefined); });
    });
  };

  if (Array.isArray(config.mcpServers) && config.mcpServers.length > 0 && config.connectMcpOnStart !== false) {
    server.connectMcpServers(config.mcpServers).catch(() => { /* a broken connector must not crash startup */ });
  }

  return server;
}
