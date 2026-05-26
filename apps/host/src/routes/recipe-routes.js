import { getRecipe, listRecipes } from '../recipes/registry.js';
import { runRecipe } from '../recipes/run-recipe.js';
import { previewFileOperations } from '../workspace/file-operations.js';
import {
  bodyFingerprint,
  decodePathSegment,
  sendJson,
  withJsonBody,
} from '../http/request-utils.js';

const RECIPE_ID_RE = /^[a-z0-9_-]+$/i;

/**
 * @typedef {import('../http/request-utils.js').HttpRequestLike & { method?: string }} RouteRequest
 * @typedef {import('../http/request-utils.js').HttpResponseLike} RouteResponse
 * @typedef {{ tenantId?: string, userId?: string, traceId?: string, idempotencyKey?: string, [key: string]: unknown }} RequestContext
 * @typedef {{ trustedRoot?: unknown, prompt?: unknown, files?: unknown, maxSize?: unknown }} RecipeRunBody
 * @typedef {{ publish(runId: string, event: Record<string, unknown>): Record<string, unknown> }} RunEventsLike
 * @typedef {{ upsert(summary: unknown, context?: Record<string, unknown>): unknown }} RunsIndexLike
 * @typedef {{ issue(input: unknown): string }} FileOperationApprovalsLike
 * @typedef {{ request: RouteRequest, response: RouteResponse, pathname: string, requestContext: RequestContext, runStoreRoot: string, runEvents?: RunEventsLike | null, runsIndex?: RunsIndexLike | null, cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string, requireIdempotencyKey(response: RouteResponse, context: RequestContext): boolean, sendCachedOrStore(response: RouteResponse, cacheKey: string, fingerprint: string, status: number, payload?: unknown): boolean | void, safeTrustedRoot(input?: unknown): string, fileOperationApprovals: FileOperationApprovalsLike }} RecipeRouteOptions
 */

/** @param {RecipeRouteOptions} options @returns {Promise<boolean>} */
export async function handleRecipeRoutes({
  request,
  response,
  pathname,
  requestContext,
  runStoreRoot,
  runEvents,
  runsIndex,
  cacheKeyFor,
  requireIdempotencyKey,
  sendCachedOrStore,
  safeTrustedRoot,
  fileOperationApprovals,
}) {
  if (request.method === 'GET' && pathname === '/api/recipes') {
    sendJson(response, 200, {
      recipes: listRecipes(),
    });
    return true;
  }

  if (request.method === 'POST' && pathname.startsWith('/api/recipes/') && pathname.endsWith('/run')) {
    await withJsonBody(request, response, async (body) => {
      const input = /** @type {RecipeRunBody} */ (body || {});
      const recipeId = decodePathSegment(pathname.slice('/api/recipes/'.length, -'/run'.length));
      if (!recipeId || !RECIPE_ID_RE.test(recipeId)) {
        sendJson(response, 400, { error: 'Invalid recipe id' });
        return;
      }
      const recipe = getRecipe(recipeId);
      if (!recipe) {
        sendJson(response, 404, { error: 'Recipe not found' });
        return;
      }
      if (!requireIdempotencyKey(response, requestContext)) {
        return;
      }
      const fingerprint = bodyFingerprint(body);
      const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
      if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
        return;
      }
      const safeRoot = safeTrustedRoot(input.trustedRoot);
      const result = runRecipe({
        recipeId,
        trustedRoot: safeRoot,
        prompt: input.prompt,
        files: Array.isArray(input.files) ? input.files : [],
        maxSize: input.maxSize,
        context: requestContext,
        runStoreRoot,
        runEvents,
        runsIndex,
      });
      const preview = result.operations.length
        ? previewFileOperations(result.operations, { trustedRoot: safeRoot })
        : { operations: [] };
      const fileOperationApprovalId = preview.operations.length
        ? fileOperationApprovals.issue({
          kind: 'file-ops:apply',
          trustedRoot: safeRoot,
          operations: preview.operations,
          context: requestContext,
        })
        : null;
      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        recipe: result.recipe,
        runId: result.runId,
        runPath: result.runPath,
        context: requestContext,
        sources: result.sources,
        operations: result.operations,
        fileOperationApprovalId,
        events: result.events,
      });
    });
    return true;
  }

  return false;
}
