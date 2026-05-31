// 工具路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/tools/* —— 列出/检索工具(ToolSearch)、调用单个工具(写操作走幂等键与审批)。
// 依赖:L0 request-utils + L1 tools 注册表(经参数注入) + L2 subagent 运行时。导出:handleToolRoutes。
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { runSubagent } from '../runtime/subagent.js';
import { runSubagentsParallel } from '../runtime/subagent-parallel.js';
import { omitUndefined } from '../util/object.js';
import {
  parseToolBody,
  parseToolSearchQuery,
  subagentParallelBodySchema,
  subagentRunBodySchema,
  toolCallBodySchema,
} from './tool-route-schemas.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type {
  RunEventsLike,
  RunsIndexLike,
  ToolRegistryLike as SubagentToolRegistryLike,
} from '../runtime/subagent.js';
import type { ToolDescriptor } from '../tools/tool-registry.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RouteError = Error & { statusCode?: number; payload?: Record<string, unknown> };
type RequestContext = { tenantId?: string; userId?: string; idempotencyKey?: string; [key: string]: unknown };
type ToolRegistryLike = SubagentToolRegistryLike & {
  list(): unknown[];
  mcpServers(): unknown[];
  search(query: string, options?: { limit?: number }): unknown[];
  has(name: string): boolean;
  descriptor(name: string): ToolDescriptor | null | undefined;
  call(name: string, args?: unknown, ctx?: unknown): unknown | Promise<unknown>;
};
export type ToolRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  toolRegistry?: ToolRegistryLike | null;
  runStoreRoot: string;
  runEvents?: RunEventsLike | null;
  runsIndex?: RunsIndexLike | null;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(
    response: HttpResponseLike,
    cacheKey: string,
    fingerprint: string | undefined,
    status: number,
    payload?: unknown,
  ): boolean | undefined;
  safeTrustedRoot(input?: unknown): string;
};

function approvalRequiredForTool(tool: ToolDescriptor | null | undefined): boolean {
  return tool?.requiresApproval === true
    || tool?.mutating === true
    || ['high', 'critical'].includes(String(tool?.risk || '').toLowerCase());
}

function rejectApprovalRequired(response: HttpResponseLike, name: string): void {
  sendJson(response, 428, {
    error: `Tool "${name}" requires agent approval and cannot be called directly from this route`,
  });
}

function errorStatus(err: unknown, fallback: number): number {
  const value = err as { statusCode?: unknown } | null | undefined;
  return typeof value?.statusCode === 'number' ? value.statusCode : fallback;
}

function errorPayload(err: unknown): { error: string } & Record<string, unknown> {
  const error = (err instanceof Error ? err : new Error(String(err))) as RouteError;
  return { error: error.message, ...(error.payload || {}) };
}

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
}: ToolRouteOptions): Promise<boolean> {
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
    const query = parseToolSearchQuery(response, requestUrl);
    if (!query) return true;
    sendJson(response, 200, {
      context: requestContext,
      query: query.query,
      tools: toolRegistry.search(query.query, omitUndefined({ limit: query.limit })),
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/tools/call') {
    await withJsonBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) return;
      const input = parseToolBody(response, toolCallBodySchema, body, 'invalid tool call request');
      if (!input) return;
      if (!toolRegistry.has(input.name)) {
        sendJson(response, 404, { error: `Unknown tool: ${input.name}` });
        return;
      }
      const descriptor = toolRegistry.descriptor(input.name);
      if (approvalRequiredForTool(descriptor)) {
        rejectApprovalRequired(response, input.name);
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      let result;
      try {
        result = await toolRegistry.call(input.name, input.args || {}, { trustedRoot, context: requestContext });
      } catch (err) {
        sendJson(response, errorStatus(err, 502), errorPayload(err));
        return;
      }
      sendCachedOrStore(response, cacheKey, fingerprint, 200, { context: requestContext, name: input.name, result });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/subagent/run') {
    await withJsonBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) return;
      const input = parseToolBody(response, subagentRunBodySchema, body, 'invalid subagent run request');
      if (!input) return;
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      const steps = input.steps || [];
      for (const step of steps) {
        const descriptor = toolRegistry.descriptor(step.tool);
        if (approvalRequiredForTool(descriptor)) {
          rejectApprovalRequired(response, step.tool);
          return;
        }
      }
      let outcome;
      try {
        outcome = await runSubagent(omitUndefined({
          goal: input.goal,
          steps,
          registry: toolRegistry,
          trustedRoot,
          runStoreRoot,
          runEvents,
          runsIndex,
          context: requestContext,
          stopOnError: input.stopOnError !== false,
        }));
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
      if (!requireIdempotencyKey(response, requestContext)) return;
      const input = parseToolBody(response, subagentParallelBodySchema, body, 'invalid subagent parallel request');
      if (!input) return;
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      const agents = input.agents || [];
      for (const agent of agents) {
        for (const step of agent.steps || []) {
          const descriptor = toolRegistry.descriptor(step.tool);
          if (approvalRequiredForTool(descriptor)) {
            rejectApprovalRequired(response, step.tool);
            return;
          }
        }
      }
      let outcome;
      try {
        outcome = await runSubagentsParallel(omitUndefined({
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
        }));
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
