// 沙箱路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/sandbox/* —— 运行内联代码(POST run-code,需幂等键、默认禁直接执行)、查询沙箱后端探测信息。
//       执行委派 L1 code-runner,落 run 记录。依赖:L0 request-utils + L1 sandbox + L2 run-store/runs-index。
// 导出:handleSandboxRoutes。
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { bindRunEventPublisher } from '../util/run-event-publisher.js';
import { normalizeSandboxSpec } from '../sandbox/index.js';
import { runCode } from '../sandbox/code-runner.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { errorMessage, errorPayload, errorStatus } from './route-error-utils.js';
import {
  parseSandboxBody,
  sandboxExecBodySchema,
  sandboxRunCodeBodySchema,
} from './sandbox-route-schemas.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { RawSandboxSpec, SandboxLimits, SandboxSpec } from '../sandbox/sandbox-spec.js';
import type { RunEventsLike, RunsIndexLike, SandboxLike } from '../sandbox/code-runner.js';

type RouteRequest = HttpRequestLike & { method?: string };
type RequestContext = { tenantId?: string; userId?: string; idempotencyKey?: string; [key: string]: unknown };
type RouteSandboxLike = SandboxLike & { networkIsolated?: unknown };
export type SandboxRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  sandbox?: RouteSandboxLike | null;
  sandboxEnabled?: boolean;
  sandboxLimits?: SandboxLimits;
  sandboxStartup?: unknown;
  runStoreRoot: string;
  runsIndex: RunsIndexLike;
  runEvents: RunEventsLike;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string | undefined, status: number, payload?: unknown): boolean | undefined;
  safeTrustedRoot(input?: unknown): string;
  allowUnsafeDirectSandboxRoutes?: boolean;
};

function promptPreview(spec: SandboxSpec): string {
  return [spec.tool, ...spec.args].join(' ').slice(0, 240);
}

function safeUpsertRunIndex(
  runsIndex: RunsIndexLike,
  record: Record<string, unknown>,
  runPath: string,
  requestContext: RequestContext,
): void {
  try {
    runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
  } catch {
    // 索引失败不应打断请求主路径。
  }
}

export async function handleSandboxRoutes({
  request,
  response,
  pathname,
  requestContext,
  sandbox,
  sandboxEnabled,
  sandboxLimits = {},
  sandboxStartup,
  runStoreRoot,
  runsIndex,
  runEvents,
  cacheKeyFor,
  requireIdempotencyKey,
  sendCachedOrStore,
  safeTrustedRoot,
  allowUnsafeDirectSandboxRoutes = false,
}: SandboxRouteOptions): Promise<boolean> {
  const requestRunEvents = bindRunEventPublisher(runEvents, requestContext);
  if (request.method === 'GET' && pathname === '/api/sandbox/info') {
    sendJson(response, 200, {
      context: requestContext,
      enabled: Boolean(sandboxEnabled),
      backend: sandbox ? sandbox.backend : null,
      networkIsolated: sandbox ? Boolean(sandbox.networkIsolated) : false,
      startup: sandboxStartup || null,
      allowTools: sandboxLimits.allowTools || null,
      maxTimeoutMs: sandboxLimits.maxTimeoutMs || null,
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/sandbox/exec') {
    await withJsonBody(request, response, async (body) => {
      if (!sandboxEnabled || !sandbox) {
        sendJson(response, 503, { error: 'Sandbox execution is disabled in this host.' });
        return;
      }
      if (!requireIdempotencyKey(response, requestContext)) return;
      if (!allowUnsafeDirectSandboxRoutes) {
        sendJson(response, 428, {
          error: 'Direct sandbox execution requires agent approval; call the sandbox tool through the approved agent flow.',
        });
        return;
      }
      const input = parseSandboxBody(response, sandboxExecBodySchema, body, 'invalid sandbox exec request');
      if (!input) return;
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;

      const rawSpec = (input.spec || input) as RawSandboxSpec;
      let spec;
      try {
        spec = normalizeSandboxSpec(rawSpec, sandboxLimits);
      } catch (err) {
        sendJson(response, errorStatus(err, 400), { error: errorMessage(err) });
        return;
      }

      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      const runId = createRunId();
      const startedAt = new Date();
      const baseRecord = {
        id: runId,
        type: 'sandbox-exec',
        provider: sandbox.backend,
        mode: 'sandbox',
        trustedRoot,
        startedAt: startedAt.toISOString(),
        context: requestContext,
        input: { prompt: promptPreview(spec), tool: spec.tool, args: spec.args },
      };
      requestRunEvents.publish(runId, { type: 'sandbox_start', tool: spec.tool, args: spec.args });

      let result;
      try {
        result = await sandbox.exec(spec, { trustedRoot, context: requestContext });
      } catch (err) {
        const finishedAt = new Date();
        const failRecord = {
          ...baseRecord,
          status: 'failed',
          finishedAt: finishedAt.toISOString(),
          durationMs: finishedAt.getTime() - startedAt.getTime(),
          error: { message: errorMessage(err) },
        };
        const runPath = writeRunRecord(runStoreRoot, failRecord);
        safeUpsertRunIndex(runsIndex, failRecord, runPath, requestContext);
        requestRunEvents.publish(runId, { type: 'sandbox_end', status: 'failed', error: errorMessage(err) });
        sendJson(response, errorStatus(err, 502), { error: errorMessage(err), runId, runPath });
        return;
      }

      const finishedAt = new Date();
      const record = {
        ...baseRecord,
        status: 'succeeded',
        finishedAt: finishedAt.toISOString(),
        durationMs: result.durationMs ?? finishedAt.getTime() - startedAt.getTime(),
        result: {
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          truncated: result.truncated,
        },
      };
      const runPath = writeRunRecord(runStoreRoot, record);
      safeUpsertRunIndex(runsIndex, record, runPath, requestContext);
      requestRunEvents.publish(runId, {
        type: 'sandbox_end',
        status: 'succeeded',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });

      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        runId,
        runPath,
        context: requestContext,
        backend: result.backend,
        spec: { tool: spec.tool, args: spec.args, timeoutMs: spec.timeoutMs, network: spec.network },
        result,
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/sandbox/run-code') {
    await withJsonBody(request, response, async (body) => {
      if (!sandboxEnabled || !sandbox) {
        sendJson(response, 503, { error: 'Sandbox execution is disabled in this host.' });
        return;
      }
      if (!requireIdempotencyKey(response, requestContext)) return;
      if (!allowUnsafeDirectSandboxRoutes) {
        sendJson(response, 428, {
          error: 'Direct sandbox execution requires agent approval; call the sandbox tool through the approved agent flow.',
        });
        return;
      }
      const input = parseSandboxBody(response, sandboxRunCodeBodySchema, body, 'invalid sandbox run-code request');
      if (!input) return;
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;

      const trustedRoot = safeTrustedRoot(input.trustedRoot);
      let outcome;
      try {
        outcome = await runCode({
          sandbox,
          sandboxLimits,
          tool: input.tool,
          code: input.code,
          prompt: input.prompt,
          ext: input.ext,
          timeoutMs: input.timeoutMs,
          network: input.network === true,
          trustedRoot,
          runStoreRoot,
          runEvents: requestRunEvents,
          runsIndex,
          context: requestContext,
        });
      } catch (err) {
        sendJson(response, errorStatus(err, 502), {
          error: errorMessage(err),
          ...errorPayload(err),
        });
        return;
      }

      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        runId: outcome.runId,
        runPath: outcome.runPath,
        context: requestContext,
        backend: outcome.backend,
        script: outcome.scriptRelative,
        spec: outcome.spec,
        result: outcome.result,
      });
    });
    return true;
  }

  return false;
}
