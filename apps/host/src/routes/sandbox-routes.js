import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { normalizeSandboxSpec } from '../sandbox/index.js';
import { runCode } from '../sandbox/code-runner.js';
import { createRunId, writeRunRecord } from '../runtime/run-store.js';
import { summariseRunForIndex } from '../runtime/runs-index.js';

// Sandbox execution routes.
//
//   GET  /api/sandbox/info      -> capabilities (enabled, backend, isolation, tools)
//   POST /api/sandbox/exec      -> run a structured SandboxSpec (idempotent, audited)
//   POST /api/sandbox/run-code  -> run an inline code snippet (idempotent, audited)
//
// Every exec/run-code produces a run record (indexed + tenant-scoped) and emits
// start/end events on the run bus, mirroring recipe runs so the timeline and
// history UIs work unchanged.

function promptPreview(spec) {
  return [spec.tool, ...spec.args].join(' ').slice(0, 240);
}

export async function handleSandboxRoutes({
  request,
  response,
  pathname,
  requestContext,
  sandbox,
  sandboxEnabled,
  sandboxLimits,
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
      const rawSpec = body && typeof body.spec === 'object' && body.spec ? body.spec : body;
      let spec;
      try {
        spec = normalizeSandboxSpec(rawSpec, sandboxLimits);
      } catch (err) {
        sendJson(response, err.statusCode || 400, { error: err.message });
        return;
      }

      const trustedRoot = safeTrustedRoot(body?.trustedRoot);
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
          error: { message: err.message },
        };
        const runPath = writeRunRecord(runStoreRoot, failRecord);
        try {
          runsIndex.upsert(summariseRunForIndex({ ...failRecord, runPath }, requestContext), requestContext);
        } catch {
          // index failures never break the request path
        }
        runEvents.publish(runId, { type: 'sandbox_end', status: 'failed', error: err.message });
        sendJson(response, err.statusCode || 502, { error: err.message, runId, runPath });
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
      try {
        runsIndex.upsert(summariseRunForIndex({ ...record, runPath }, requestContext), requestContext);
      } catch {
        // index failures never break the request path
      }
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

      const trustedRoot = safeTrustedRoot(body?.trustedRoot);
      let outcome;
      try {
        outcome = await runCode({
          sandbox,
          sandboxLimits,
          tool: body?.tool,
          code: body?.code,
          prompt: body?.prompt,
          ext: body?.ext,
          timeoutMs: body?.timeoutMs,
          network: body?.network === true,
          trustedRoot,
          runStoreRoot,
          runEvents,
          runsIndex,
          context: requestContext,
        });
      } catch (err) {
        sendJson(response, err.statusCode || 502, {
          error: err.message,
          ...(err.payload || {}),
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
