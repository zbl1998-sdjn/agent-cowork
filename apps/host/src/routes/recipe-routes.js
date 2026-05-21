import { getRecipe, listRecipes } from '../recipes/registry.js';
import { runRecipe } from '../recipes/run-recipe.js';
import {
  bodyFingerprint,
  decodePathSegment,
  sendJson,
  withJsonBody,
} from '../http/request-utils.js';

const RECIPE_ID_RE = /^[a-z0-9_-]+$/i;

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
}) {
  if (request.method === 'GET' && pathname === '/api/recipes') {
    sendJson(response, 200, {
      recipes: listRecipes(),
    });
    return true;
  }

  if (request.method === 'POST' && pathname.startsWith('/api/recipes/') && pathname.endsWith('/run')) {
    await withJsonBody(request, response, async (body) => {
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
      const safeRoot = safeTrustedRoot(body.trustedRoot);
      const result = runRecipe({
        recipeId,
        trustedRoot: safeRoot,
        prompt: body.prompt,
        files: body.files,
        maxSize: body.maxSize,
        context: requestContext,
        runStoreRoot,
        runEvents,
        runsIndex,
      });
      sendCachedOrStore(response, cacheKey, fingerprint, 200, {
        recipe: result.recipe,
        runId: result.runId,
        runPath: result.runPath,
        context: requestContext,
        sources: result.sources,
        operations: result.operations,
        events: result.events,
      });
    });
    return true;
  }

  return false;
}
