// HTTP 服务器组装根(host · L4 组装根 · server.ts)
// ---------------------------------------------------------------------------
// 职责:唯一「连线」层——创建运行时依赖(host-state)、装中间件(安全头/CORS/限流)、按身份附着请求上下文、
//       挂载静态资源与路由链,接入 MCP、提供优雅停机。本层不写业务逻辑,只做组装(plan/00 L4)。
// 依赖:L0 http/* · L1 auth/mcp/security · L2 runtime/host-state · L3 routes/route-chain。导出:createServer。
// 注:这是 plan/00 标注的 P0 上帝类(体积白名单),目标后续把中间件/路由进一步下沉,server.ts 只留装配。
import http from 'node:http';
import type { IncomingMessage, Server as HttpServer, ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachRequestIdentity } from './auth/request-identity.js';
import { applyRequestMiddleware } from './http/middleware/common.js';
import { createRequestContext, sendJson } from './http/request-utils.js';
import { createStaticResponder } from './http/static-assets.js';
import { connectMcpServers, closeMcpClients } from './mcp/connect.js';
import type { ConnectedMcpClient, ConnectMcpResult, McpServerSpec } from './mcp/connect.js';
import type { SpawnFn } from './mcp/stdio-transport.js';
import { handleRouteChain } from './routes/route-chain.js';
import { filterMcpServersForConfidential, applyConfidentialProxyLockdown } from './security/confidential.js';
import { resolveSecurityMode } from './security/security-mode.js';
import { setAtRestSecurityMode } from './security/at-rest.js';
import { createHostState } from './runtime/host-state.js';
import type { HostConfig } from './runtime/host-state-types.js';
import { redactText } from './security/redaction.js';
import { omitUndefined } from './util/object.js';

const hostSrcDir = path.dirname(fileURLToPath(import.meta.url));

export type ServerConfig = HostConfig & {
  mcpServers?: McpServerSpec[];
  connectMcpOnStart?: boolean;
  mcpSpawn?: SpawnFn;
};

export type HostServer = HttpServer & {
  toolRegistry?: unknown;
  _mcpClients: ConnectedMcpClient[];
  connectMcpServers(servers?: unknown): Promise<ConnectMcpResult>;
  closeMcp(): void;
  isDraining(): boolean;
  shutdown(options?: { timeoutMs?: number }): Promise<void>;
};

export function createServer(config: ServerConfig = {}): HostServer {
  const state = createHostState(config, { hostSrcDir });
  const serveStatic = createStaticResponder({
    staticRoot: state.staticRoot,
    uiDistRoot: state.uiDistRoot,
    uiDistEnabled: state.uiDistEnabled,
  });

  const server = http.createServer(async (request: IncomingMessage, response: ServerResponse) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;
      const requestContext = createRequestContext(request);
      requestContext.securityMode = state.securityMode;
      attachRequestIdentity(omitUndefined({
        request,
        requestContext,
        authStore: state.authStore,
        jwtSecret: state.jwtSecret,
        trustIdentityHeaders: state.trustIdentityHeaders,
      }));
      if (applyRequestMiddleware(omitUndefined({
        request,
        response,
        pathname,
        requestContext,
        rateLimiter: state.rateLimiter,
        requireAuth: state.requireAuth,
        validateHost: state.validateHost,
      }))) {
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
        /* 日志写出失败时仍返回 500 */
      }
      sendJson(response, 500, { error: 'internal server error' });
    }
  }) as HostServer;

  server.toolRegistry = state.toolRegistry;
  server._mcpClients = [];
  server.connectMcpServers = async (servers: unknown = []): Promise<ConnectMcpResult> => {
    const outcome = await connectMcpServers(omitUndefined({
      registry: state.toolRegistry,
      servers: servers as Array<McpServerSpec | null | undefined>,
      spawn: config.mcpSpawn,
    }));
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
    try { state.cancellation.cancelAll('shutdown'); } catch { /* 停机取消失败时继续收尾 */ }
    try { state.approvalRegistry.cancelAll?.('reject'); } catch { /* 审批取消失败时继续收尾 */ }
    try { server.closeMcp(); } catch { /* MCP 关闭失败时继续收尾 */ }
    try {
      if (state.activeScheduler && typeof state.activeScheduler.stop === 'function') state.activeScheduler.stop();
    } catch {
      /* 调度器停止失败时继续关闭 HTTP */
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      try {
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      } catch {
        /* closeAllConnections 不可用或失败时交给 server.close */
      }
      server.close(() => { clearTimeout(timer); resolve(); });
    });
  };

  // 机密模式咽喉:剥离转发代理环境变量——切断子进程经本机代理(loopback,防火墙封不住)外泄。
  // 无条件在装配处执行(不依赖 mcpServers),覆盖 main.ts 与嵌入式两条路径;非机密模式空操作。
  const proxyLockdown = applyConfidentialProxyLockdown();
  if (proxyLockdown.applied) {
    console.warn(`[host] 机密模式:已剥离代理环境变量并置 NO_PROXY=*${proxyLockdown.stripped.length ? `(移除 ${proxyLockdown.stripped.join(', ')})` : '(原无代理变量)'}`);
  }

  // 落盘加密默认策略:注入权威 securityMode(含 config),让 stores 落盘时的加密开关跟随实际档位
  // (air_gap 强制开、local_strict/enterprise_local 默认开),不再只认 env。
  const resolvedMode = resolveSecurityMode({ configuredMode: state.securityMode, env: process.env });
  setAtRestSecurityMode(resolvedMode);

  if (Array.isArray(config.mcpServers) && config.mcpServers.length > 0 && config.connectMcpOnStart !== false) {
    // 机密模式咽喉:启动期 MCP(含 MASE 记忆桥接)在此统一过滤——覆盖 main.ts 与嵌入式调用两条装配路径。
    const mcpFilter = filterMcpServersForConfidential(config.mcpServers);
    if (mcpFilter.dropped.length > 0) console.warn(`[host] ${mcpFilter.reason}(丢弃 ${mcpFilter.dropped.length} 个)`);
    if (mcpFilter.servers.length > 0) {
      server.connectMcpServers(mcpFilter.servers).catch(() => { /* 连接器损坏不能拖垮 host 启动 */ });
    }
  }

  return server;
}
