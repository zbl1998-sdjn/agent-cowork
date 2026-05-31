// 沙箱路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/sandbox/* —— 运行内联代码(POST run-code,需幂等键、默认禁直接执行)、查询沙箱后端探测信息。
//       执行委派 L1 code-runner,落 run 记录。依赖:L0 request-utils + L1 sandbox + L2 run-store/runs-index。
// 导出:handleSandboxRoutes。
// @ts-check
import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { normalizeSandboxSpec } from '../sandbox/index.js';
import { runCode } from '../sandbox/code-runner.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';
import { errorMessage, errorPayload, errorStatus } from './route-error-utils.js';

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {import('../http/middleware/common.js').RequestContext} RequestContext
 * @typedef {import('../sandbox/sandbox-spec.js').SandboxSpec} SandboxSpec
 * @typedef {import('../sandbox/sandbox-spec.js').SandboxLimits} SandboxLimits
 * @typedef {import('../sandbox/code-runner.js').SandboxLike} SandboxLike
 * @typedef {SandboxLike & { networkIsolated?: unknown }} RouteSandboxLike
 * @typedef {{ publish(runId: string, event: Record<string, unknown>): Record<string, unknown> }} RunEventsLike
 * @typedef {{ upsert(summary: unknown, context?: RequestContext): unknown }} RunsIndexLike
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext: RequestContext, sandbox?: RouteSandboxLike | null, sandboxEnabled?: boolean, sandboxLimits?: SandboxLimits, sandboxStartup?: unknown, runStoreRoot: string, runsIndex: RunsIndexLike, runEvents: RunEventsLike, cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: RequestContext): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void, safeTrustedRoot(input?: unknown): string, allowUnsafeDirectSandboxRoutes?: boolean }} SandboxRouteOptions
 */

/** @param {unknown} body @returns {Record<string, unknown>} */
function objectBody(body) { return body && typeof body === 'object' && !Array.isArray(body) ? /** @type {Record<string, unknown>} */ (body) : {}; }

/** @param {SandboxSpec} spec @returns {string} */
function promptPreview(spec) {
  return [spec.tool, ...spec.args].join(' ').slice(0, 240);
}

/** @param {RunsIndexLike} runsIndex @param {unknown} record @param {string} runPath @param {RequestContext} requestContext */
function safeUpsertRunIndex(runsIndex, record, runPath, requestContext) {
  try {
    runsIndex.upsert(summariseRunForIndex({ .../** @type {Record<string, unknown>} */ (record), runPath }, requestContext), requestContext);
  } catch { /* index failures never break the request path */ }
}

/** @param {SandboxRouteOptions} options @returns {Promise<boolean>} */
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
}) {
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
      const input = objectBody(body);
      if (!sandboxEnabled || !sandbox) {
        sendJson(response, 503, { error: 'Sandbox execution is disabled in this host.' });
        return;
      }
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      if (!allowUnsafeDirectSandboxRoutes) {
        sendJson(response, 428, {
          error: 'Direct sandbox execution requires agent approval; call the sandbox tool through the approved agent flow.',
        });
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }

      // Accept either { spec: {...} } or the spec fields at the top level.
      const rawSpec = input.spec && typeof input.spec === 'object' && !Array.isArray(input.spec) ? input.spec : input;
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
      runEvents.publish(runId, { type: 'sandbox_start', tool: spec.tool, args: spec.args });

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
        runEvents.publish(runId, { type: 'sandbox_end', status: 'failed', error: errorMessage(err) });
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
      runEvents.publish(runId, {
        type: 'sandbox_end',
        status: 'succeeded',
        exitCode: result.exitCode,
        timedOut: result.timedOut,
      });

      const payload = {
        runId,
        runPath,
        context: requestContext,
        backend: result.backend,
        spec: { tool: spec.tool, args: spec.args, timeoutMs: spec.timeoutMs, network: spec.network },
        result,
      };
      sendCachedOrStore(response, cacheKey, fingerprint, 200, payload);
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/sandbox/run-code') {
    await withJsonBody(request, response, async (body) => {
      const input = objectBody(body);
      if (!sandboxEnabled || !sandbox) {
        sendJson(response, 503, { error: 'Sandbox execution is disabled in this host.' });
        return;
      }
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      if (!allowUnsafeDirectSandboxRoutes) {
        sendJson(response, 428, {
          error: 'Direct sandbox execution requires agent approval; call the sandbox tool through the approved agent flow.',
        });
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }

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
          runEvents,
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

      const payload = {
        runId: outcome.runId,
        runPath: outcome.runPath,
        context: requestContext,
        backend: outcome.backend,
        script: outcome.scriptRelative,
        spec: outcome.spec,
        result: outcome.result,
      };
      sendCachedOrStore(response, cacheKey, fingerprint, 200, payload);
    });
    return true;
  }

  return false;
}
