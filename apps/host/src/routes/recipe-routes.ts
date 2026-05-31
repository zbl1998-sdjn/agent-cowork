// 配方路由(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:处理 /api/recipes/* —— 列出配方、运行配方(POST /api/recipes/:id/run)、保存自定义配方。
//       运行委派给 L1 run-recipe(与调度器共用),产出可审批操作 + run 记录。
// 依赖:L1 recipes/workspace(经参数注入)。导出:handleRecipeRoutes。
import path from 'node:path';
import { z } from 'zod';
import { getRecipe, listRecipes } from '../recipes/registry.js';
import { runRecipe } from '../recipes/run-recipe.js';
import { captureRun } from '../recipes/capture.js';
import { createCustomRecipeStore } from '../recipes/custom-recipes.js';
import { previewFileOperations } from '../workspace/file-operations.js';
import {
  bodyFingerprint,
  decodePathSegment,
  sendJson,
  withJsonBody,
} from '../http/request-utils.js';
import type { HttpRequestLike, HttpResponseLike } from '../http/request-utils.js';
import type { Recipe } from '../recipes/registry.js';
import type { RunEventsLike, RunsIndexLike } from '../recipes/run-recipe-types.js';

const RECIPE_ID_RE = /^[a-z0-9_-]+$/i;

type RouteRequest = HttpRequestLike & { method?: string };
type RequestContext = { tenantId?: string; userId?: string; traceId?: string; idempotencyKey?: string; [key: string]: unknown };
type RunIndexEntryLike = { runPath?: unknown };
type CaptureRunsIndexLike = RunsIndexLike & {
  get?(runId: string, options?: { tenantId?: unknown }): RunIndexEntryLike | null | Promise<RunIndexEntryLike | null>;
};
type FileOperationApprovalsLike = { issue(input: unknown): string };
type RecipeRouteOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestContext: RequestContext;
  runStoreRoot: string;
  runEvents?: RunEventsLike | null;
  runsIndex?: CaptureRunsIndexLike | null;
  cacheKeyFor(context: RequestContext, method?: string, pathname?: string): string;
  requireIdempotencyKey(response: HttpResponseLike, context: RequestContext): boolean;
  sendCachedOrStore(response: HttpResponseLike, cacheKey: string, fingerprint: string, status: number, payload?: unknown): unknown;
  safeTrustedRoot(input?: unknown): string;
  fileOperationApprovals: FileOperationApprovalsLike;
};

const trustedRootSchema = z.preprocess(
  (value) => (value === '' || value == null ? undefined : value),
  z.string().optional(),
);
const objectBodySchema = z.object({}).passthrough();
const customRecipeBodySchema = z.object({
  recipe: objectBodySchema.optional(),
}).passthrough();
const captureBodySchema = z.object({
  runId: z.string().trim().regex(RECIPE_ID_RE, 'Invalid run id'),
}).passthrough();
const recipeRunBodySchema = z.object({
  trustedRoot: trustedRootSchema,
  prompt: z.unknown().optional(),
  files: z.array(z.unknown(), 'files must be an array').optional(),
  maxSize: z.unknown().optional(),
}).passthrough();

function customRecipeStoreFor(runStoreRoot: string): ReturnType<typeof createCustomRecipeStore> {
  const agentRoot = path.dirname(path.resolve(runStoreRoot));
  return createCustomRecipeStore({ storePath: path.join(agentRoot, 'recipes', 'custom-recipes.json') });
}

function errorMessage(err: unknown, fallback = 'invalid recipe request'): string {
  if (err instanceof z.ZodError) return err.issues[0]?.message || fallback;
  return err instanceof Error ? err.message : String(err);
}

function cachedWrite(
  options: Pick<RecipeRouteOptions, 'request' | 'response' | 'pathname' | 'requestContext' | 'cacheKeyFor' | 'requireIdempotencyKey' | 'sendCachedOrStore'>,
  body: unknown,
  handler: () => unknown,
): void {
  const { request, response, pathname, requestContext, cacheKeyFor, requireIdempotencyKey, sendCachedOrStore } = options;
  if (!requireIdempotencyKey(response, requestContext)) return;
  const fingerprint = bodyFingerprint(body);
  const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
  if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) return;
  const payload = handler();
  sendCachedOrStore(response, cacheKey, fingerprint, 200, payload);
}

export async function handleRecipeRoutes(options: RecipeRouteOptions): Promise<boolean> {
  const {
    request,
    response,
    pathname,
    requestContext,
    runStoreRoot,
    runEvents,
    runsIndex,
    safeTrustedRoot,
    fileOperationApprovals,
  } = options;
  const customRecipes = customRecipeStoreFor(runStoreRoot);

  if (request.method === 'GET' && pathname === '/api/recipes') {
    sendJson(response, 200, {
      recipes: [...listRecipes(), ...customRecipes.list({ tenantId: requestContext.tenantId })],
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/recipes/custom') {
    await withJsonBody(request, response, async (body) => {
      const parsed = customRecipeBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      cachedWrite(options, body, () => {
        const input = parsed.data;
        const recipeInput = input.recipe || input;
        const recipe = customRecipes.save(recipeInput, { tenantId: requestContext.tenantId, userId: requestContext.userId });
        return {
          ok: true,
          recipe,
          context: requestContext,
        };
      });
    });
    return true;
  }

  if (request.method === 'POST' && pathname === '/api/recipes/capture') {
    await withJsonBody(request, response, async (body) => {
      const parsed = captureBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      if (!runsIndex || typeof runsIndex.get !== 'function') {
        sendJson(response, 503, { error: 'Runs index is not available' });
        return;
      }
      const scopedRunsIndex = {
        get(id: string): RunIndexEntryLike | null | Promise<RunIndexEntryLike | null> {
          return runsIndex.get?.(id, { tenantId: requestContext.tenantId }) || null;
        },
      };
      const result = await captureRun({ runId: parsed.data.runId, runsIndex: scopedRunsIndex });
      sendJson(response, 200, {
        ...result,
        context: requestContext,
      });
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
      const parsed = recipeRunBodySchema.safeParse(body);
      if (!parsed.success) {
        sendJson(response, 400, { error: errorMessage(parsed.error) });
        return;
      }
      const recipe = getRecipe(recipeId);
      const customRecipe = recipe ? null : customRecipes.get(recipeId, { tenantId: requestContext.tenantId });
      const selectedRecipe: Recipe | null = recipe || customRecipe;
      if (!selectedRecipe) {
        sendJson(response, 404, { error: 'Recipe not found' });
        return;
      }
      cachedWrite(options, body, () => {
        const input = parsed.data;
        const safeRoot = safeTrustedRoot(input.trustedRoot);
        const result = runRecipe({
          recipeId,
          trustedRoot: safeRoot,
          prompt: input.prompt,
          files: input.files || [],
          maxSize: input.maxSize,
          context: requestContext,
          runStoreRoot,
          runEvents,
          runsIndex,
          recipe: selectedRecipe,
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
        return {
          recipe: result.recipe,
          runId: result.runId,
          runPath: result.runPath,
          context: requestContext,
          sources: result.sources,
          operations: result.operations,
          fileOperationApprovalId,
          events: result.events,
        };
      });
    });
    return true;
  }

  return false;
}
