import { bodyFingerprint, sendJson, withJsonBody } from '../http/request-utils.js';
import { runSubagent } from '../runtime/subagent.js';

// Tool + sub-agent routes.
//
//   GET  /api/tools             -> every registered tool descriptor
//   GET  /api/tools/search?q=   -> keyword-ranked tools (ToolSearch analog)
//   POST /api/tools/call        -> invoke one tool (idempotent, trusted-root jail)
//   POST /api/subagent/run      -> run a plan (sequence of tool calls), recorded
//
// Mutating routes require an Idempotency-Key and replay through the same cache
// the recipe/sandbox routes use, so a retried request never double-executes.

function approvalRequiredForTool(tool) {
  return tool?.requiresApproval === true || tool?.mutating === true || ['high', 'critical'].includes(String(tool?.risk || '').toLowerCase());
}

function rejectApprovalRequired(response, name) {
  sendJson(response, 428, {
    error: `Tool "${name}" requires agent approval and cannot be called directly from this route`,
  });
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
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const name = body && typeof body.name === 'string' ? body.name.trim() : '';
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
      const trustedRoot = safeTrustedRoot(body?.trustedRoot);
      let result;
      try {
        result = await toolRegistry.call(name, body.args || {}, { trustedRoot, context: requestContext });
      } catch (err) {
        sendJson(response, err.statusCode || 502, { error: err.message });
        return;
      }
      sendCachedOrStore(response, cacheKey, fingerprint, 200, { context: requestContext, name, result });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/subagent/run') {
    await withJsonBody(request, response, async (body) => {
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const trustedRoot = safeTrustedRoot(body?.trustedRoot);
      const steps = Array.isArray(body?.steps) ? body.steps : [];
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
          goal: body?.goal,
          steps: body?.steps,
          registry: toolRegistry,
          trustedRoot,
          runStoreRoot,
          runEvents,
          runsIndex,
          context: requestContext,
          stopOnError: body?.stopOnError !== false,
        });
      } catch (err) {
        sendJson(response, err.statusCode || 502, { error: err.message, ...(err.payload || {}) });
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

  return false;
}
