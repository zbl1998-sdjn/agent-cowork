import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { runSubagent } from '../runtime/subagent.js';
import { runSubagentsParallel } from '../runtime/subagent-parallel.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {Error & { statusCode?: number, payload?: Record<string, unknown> }} RouteError
 * @typedef {{ tenantId?: string, userId?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ requiresApproval?: boolean, mutating?: boolean, risk?: string }} ToolDescriptor
 * @typedef {{ list(): unknown[], mcpServers(): unknown[], search(query: string, options?: { limit?: number }): unknown[], has(name: string): boolean, descriptor(name: string): ToolDescriptor | undefined, call(name: string, args?: unknown, ctx?: unknown): unknown | Promise<unknown> }} ToolRegistryLike
 * @typedef {{ trustedRoot?: unknown, name?: unknown, args?: unknown, steps?: any[], agents?: any[], goal?: unknown, stopOnError?: unknown, maxConcurrency?: number }} ToolRouteBody
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestUrl: URL, requestContext: RequestContext, toolRegistry?: ToolRegistryLike, runStoreRoot: string, runEvents?: any, runsIndex?: any, cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: RequestContext): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void, safeTrustedRoot(input?: unknown): string }} ToolRouteOptions
 */

// Tool + sub-agent routes.
//
//   GET  /api/tools             -> every registered tool descriptor
//   GET  /api/tools/search?q=   -> keyword-ranked tools (ToolSearch analog)
//   POST /api/tools/call        -> invoke one tool (idempotent, trusted-root jail)
//   POST /api/subagent/run      -> run a plan (sequence of tool calls), recorded
//   POST /api/subagent/parallel -> run multiple sub-agent plans concurrently
//
// Mutating routes require an Idempotency-Key and replay through the same cache
// the recipe/sandbox routes use, so a retried request never double-executes.

/** @param {ToolDescriptor | undefined} tool */
function approvalRequiredForTool(tool) {
  return tool?.requiresApproval === true || tool?.mutating === true || ['high', 'critical'].includes(String(tool?.risk || '').toLowerCase());
}

/** @param {RouteResponse} response @param {string} name */
function rejectApprovalRequired(response, name) {
  sendJson(response, 428, {
    error: `Tool "${name}" requires agent approval and cannot be called directly from this route`,
  });
}

/** @param {unknown} err @param {number} fallback */
function errorStatus(err, fallback) {
  return err && typeof err === 'object' && 'statusCode' in err && typeof err.statusCode === 'number'
    ? err.statusCode
    : fallback;
}

/** @param {unknown} err */
function errorPayload(err) {
  const error = /** @type {RouteError} */ (err instanceof Error ? err : new Error(String(err)));
  return { error: error.message, ...(error.payload || {}) };
}

/** @param {ToolRouteOptions} options */
export async function handleToolRoutes({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  toolRegistry,
  runStoreRoot,
  runEvents,
  runsIndex,
  cacheKeyFor,
  requireIdempotencyKey,
  sendCachedOrStore,
  safeTrustedRoot,
}) {
  if (!toolRegistry) {
    return false;
  }

  if (request.method === 'GET' && pathname === '/api/tools') {
    sendJson(response, 200, {
      context: requestContext,
      tools: toolRegistry.list(),
      mcpServers: toolRegistry.mcpServers(),
    });
    return true;
  }

  if (request.method === 'GET' && pathname === '/api/tools/search') {
    const query = requestUrl.searchParams.get('q') || requestUrl.searchParams.get('query') || '';
    const limit = Math.max(1, Math.min(Number(requestUrl.searchParams.get('limit') || 10), 50));
    sendJson(response, 200, {
      context: requestContext,
      query,
      tools: toolRegistry.search(query, { limit }),
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/tools/call') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {ToolRouteBody} */ (body || {});
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      if (!name) {
        sendJson(response, 400, { error: 'body.name is required' });
        return;
      }
      if (!toolRegistry.has(name)) {
        sendJson(response, 404, { error: `Unknown tool: ${name}` });
        return;
      }
      const descriptor = toolRegistry.descriptor(name);
      if (approvalRequiredForTool(descriptor)) {
        rejectApprovalRequired(response, name);
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      let result;
      try {
        result = await toolRegistry.call(name, input.args || {}, { trustedRoot, context: requestContext });
      } catch (err) {
        sendJson(response, errorStatus(err, 502), errorPayload(err));
        return;
      }
      sendCachedOrStore(response, cacheKey, fingerprint, 200, { context: requestContext, name, result });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/subagent/run') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {ToolRouteBody} */ (body || {});
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      const steps = Array.isArray(input.steps) ? input.steps : [];
      for (const step of steps) {
        const toolName = typeof step?.tool === 'string' ? step.tool.trim() : '';
        const descriptor = toolRegistry.descriptor(toolName);
        if (approvalRequiredForTool(descriptor)) {
          rejectApprovalRequired(response, toolName);
          return;
        }
      }
      let outcome;
      try {
        outcome = await runSubagent({
          goal: input.goal,
          steps: input.steps,
          registry: toolRegistry,
          trustedRoot,
          runStoreRoot,
          runEvents,
          runsIndex,
          context: requestContext,
          stopOnError: input.stopOnError !== false,
        });
      } catch (err) {
        sendJson(response, errorStatus(err, 502), errorPayload(err));
        return;
      }
      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        context: requestContext,
        runId: outcome.runId,
        runPath: outcome.runPath,
        ok: outcome.ok,
        goal: outcome.goal,
        steps: outcome.steps,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/subagent/parallel') {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {ToolRouteBody} */ (body || {});
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      const agents = Array.isArray(input.agents) ? input.agents : [];
      for (const agent of agents) {
        const steps = Array.isArray(agent?.steps) ? agent.steps : [];
        for (const step of steps) {
          const toolName = typeof step?.tool === 'string' ? step.tool.trim() : '';
          const descriptor = toolRegistry.descriptor(toolName);
          if (approvalRequiredForTool(descriptor)) {
            rejectApprovalRequired(response, toolName);
            return;
          }
        }
      }
      let outcome;
      try {
        outcome = await runSubagentsParallel({
          goal: input.goal,
          agents,
          registry: toolRegistry,
          trustedRoot,
          runStoreRoot,
          runEvents,
          runsIndex,
          context: requestContext,
          stopOnError: input.stopOnError !== false,
          maxConcurrency: input.maxConcurrency,
        });
      } catch (err) {
        sendJson(response, errorStatus(err, 502), errorPayload(err));
        return;
      }
      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        context: requestContext,
        runId: outcome.runId,
        runPath: outcome.runPath,
        ok: outcome.ok,
        goal: outcome.goal,
        children: outcome.children,
      });
    });
    return true;
  }

  return false;
}
