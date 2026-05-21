import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listWorkspaceTree } from './workspace/file-tree.js';
import { readTextFile } from './workspace/file-reader.js';
import { extractDocumentText } from './workspace/document-extractor.js';
import { searchWorkspace } from './workspace/file-search.js';
import { buildContextBundle } from './workspace/context-bundle.js';
import { previewFileOperations, applyFileOperations } from './workspace/file-operations.js';
import { importUploadedFiles } from './workspace/uploads.js';
import { buildRecipeOperations, getRecipe, listRecipes } from './recipes/registry.js';
import { detectKimiInfo } from './kimi/cli-detect.js';
import { runKimiCliChat, runKimiCliPlan } from './kimi/cli-runner.js';
import { createRunId, writeRunRecord } from './runtime/run-store.js';
import { createRunsIndex, summariseRunForIndex } from './runtime/runs-index.js';
import { Scheduler, createScheduleStore } from './runtime/scheduler.js';
import { RunEventBus } from './runtime/run-events.js';
import { runRecipe } from './recipes/run-recipe.js';
import { createMemoryStore } from './memory/memory-store.js';
import { assertTrustedPath } from './security/path-policy.js';
import { handleMemoryRoutes } from './routes/memory-routes.js';
import { handleRunRoutes } from './routes/run-routes.js';
import { handleScheduleRoutes } from './routes/schedule-routes.js';
import fs from 'node:fs';
import {
  bodyFingerprint,
  createRequestContext,
  headerValue,
  isAllowedOrigin,
  requiresOriginCheck,
  sendFile,
  sendJson,
  withJsonBody,
} from './http/request-utils.js';

const hostSrcDir = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = path.resolve(hostSrcDir, '../../windows-client/resources');
const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app-utils.js', { file: 'app-utils.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-api-client.js', { file: 'app-api-client.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-run-events.js', { file: 'app-run-events.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

export function createServer(config = {}) {
  const trustedRootDefault = path.resolve(config.trustedRoot || process.env.TRUSTED_ROOT || process.cwd());
  const staticRoot = config.staticRoot === false ? null : path.resolve(config.staticRoot || defaultStaticRoot);
  const kimiCliPlanEnabled = config.enableKimiCliPlan === true;
  const kimiPlanRunner = config.kimiPlanRunner || runKimiCliPlan;
  const kimiChatRunner = config.kimiChatRunner || runKimiCliChat;
  const runStoreRoot = path.resolve(config.runStoreRoot || path.join(trustedRootDefault, '.KimiCowork', 'runs'));
  const idempotencyStore = config.idempotencyStore || new Map();
  const runsIndexRoot = path.resolve(config.runsIndexRoot || path.join(trustedRootDefault, '.KimiCowork', 'index'));
  const storeBackend = String(config.storeBackend || process.env.KCW_STORE || 'file').toLowerCase() === 'sqlite'
    ? 'sqlite'
    : 'file';
  const sqliteDbPath = path.resolve(
    config.sqliteDbPath || process.env.KCW_SQLITE_PATH || path.join(trustedRootDefault, '.KimiCowork', 'state.sqlite'),
  );
  const runsIndex = config.runsIndex || createRunsIndex({
    backend: storeBackend,
    indexRoot: runsIndexRoot,
    dbPath: sqliteDbPath,
  });
  const memoryStore = config.memoryStore || createMemoryStore({
    backend: storeBackend,
    dbPath: sqliteDbPath,
  });
  const runEvents = config.runEventBus || new RunEventBus();
  const scheduleStoreDir = path.resolve(config.scheduleStoreDir || path.join(trustedRootDefault, '.KimiCowork', 'schedules'));
  const scheduler = config.scheduler || null;
  let activeScheduler = scheduler;
  if (!activeScheduler && config.enableScheduler !== false) {
    const defaultExecutor = config.scheduleExecutor || (async (record) => {
      const payload = record.payload || {};
      if (!payload.recipeId) {
        return { runId: null, note: `scheduler-noop:${record.id}` };
      }
      const result = runRecipe({
        recipeId: payload.recipeId,
        trustedRoot: safeTrustedRoot(payload.trustedRoot || trustedRootDefault),
        prompt: payload.prompt || '',
        files: payload.files || [],
        maxSize: payload.maxSize,
        context: { tenantId: record.tenantId, userId: record.userId, traceId: record.traceId || '' },
        runStoreRoot,
        runEvents,
        runsIndex,
      });
      return { runId: result.runId, operations: result.operations.length };
    });
    activeScheduler = new Scheduler({
      storeDir: scheduleStoreDir,
      store: config.scheduleStore || createScheduleStore({
        backend: storeBackend,
        storeDir: scheduleStoreDir,
        dbPath: sqliteDbPath,
      }),
      executor: defaultExecutor,
      tickIntervalMs: config.schedulerTickMs || 30_000,
    });
    if (config.startScheduler !== false) {
      activeScheduler.start();
    }
  }
  function indexRun(record, ctx) {
    try {
      const summary = summariseRunForIndex({ ...record, runPath: record.runPath }, ctx || record.context || {});
      runsIndex.upsert(summary, ctx || record.context || {});
    } catch {
      // index failures must never break the request path
    }
  }

  function safeTrustedRoot(requestedRoot = trustedRootDefault) {
    return assertTrustedPath(path.resolve(requestedRoot || trustedRootDefault), trustedRootDefault);
  }

  function cacheKeyFor(context, method, pathname) {
    if (!context.idempotencyKey) {
      return '';
    }
    return `${context.tenantId}:${context.userId}:${method}:${pathname}:${context.idempotencyKey}`;
  }

  function requireIdempotencyKey(response, context) {
    if (context.idempotencyKey) {
      return true;
    }
    sendJson(response, 428, { error: 'Idempotency-Key header is required for this write operation' });
    return false;
  }

  function sendCachedOrStore(response, cacheKey, fingerprint, status, payload) {
    if (cacheKey && idempotencyStore.has(cacheKey)) {
      const cached = idempotencyStore.get(cacheKey);
      if (fingerprint && cached.fingerprint && cached.fingerprint !== fingerprint) {
        sendJson(response, 409, { error: 'Idempotency-Key reused with different request body' });
        return true;
      }
      sendJson(response, cached.status, {
        ...cached.payload,
        idempotentReplay: true,
      });
      return true;
    }
    if (payload === undefined) {
      return false;
    }
    if (cacheKey) {
      idempotencyStore.set(cacheKey, {
        status,
        payload,
        fingerprint,
      });
    }
    sendJson(response, status, payload);
    return false;
  }

  async function runKimiAndRecord({
    type,
    mode,
    trustedRoot,
    prompt,
    summary,
    runner,
    response,
    context,
  }) {
    const runId = createRunId();
    const startedAt = new Date();
    const baseRecord = {
      id: runId,
      type,
      provider: 'kimi-cli',
      command: config.kimiExecutable || 'kimi',
      mode,
      trustedRoot,
      startedAt: startedAt.toISOString(),
      input: {
        prompt,
        summary: typeof summary === 'string' ? summary : '',
      },
      context,
    };
    const memoryContext = memoryStore.loadMemoryContext(trustedRoot, {
      maxBytes: 4096,
      context,
    });
    if (memoryContext.enabled) {
      baseRecord.memory = {
        enabled: true,
        bytes: memoryContext.bytes,
        notes: memoryContext.notes,
      };
    }
    try {
      const result = await runner({
        command: baseRecord.command,
        trustedRoot,
        prompt,
        summary,
        mode,
        memory: memoryContext.text,
        timeoutMs: config.kimiCliTimeoutMs,
        maxSteps: config.kimiCliMaxSteps,
        model: config.kimiModel,
      });
      const finishedAt = new Date();
      const runPath = writeRunRecord(runStoreRoot, {
        ...baseRecord,
        status: 'succeeded',
        finishedAt: finishedAt.toISOString(),
        durationMs: result.durationMs ?? finishedAt.getTime() - startedAt.getTime(),
        result: {
          ok: result.ok,
          text: result.text,
        },
      });
      indexRun({
        id: runId,
        type: baseRecord.type,
        status: 'succeeded',
        mode: baseRecord.mode,
        provider: baseRecord.provider,
        startedAt: baseRecord.startedAt,
        finishedAt: finishedAt.toISOString(),
        durationMs: result.durationMs ?? finishedAt.getTime() - startedAt.getTime(),
        input: baseRecord.input,
        runPath,
      }, context);
      sendJson(response, 200, {
        ...result,
        runId,
        runPath,
        memory: memoryContext.enabled
          ? { enabled: true, bytes: memoryContext.bytes, notes: memoryContext.notes }
          : { enabled: false },
      });
    } catch (err) {
      const finishedAt = new Date();
      const runPath = writeRunRecord(runStoreRoot, {
        ...baseRecord,
        status: 'failed',
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        error: {
          message: err.message,
        },
      });
      indexRun({
        id: runId,
        type: baseRecord.type,
        status: 'failed',
        mode: baseRecord.mode,
        provider: baseRecord.provider,
        startedAt: baseRecord.startedAt,
        finishedAt: finishedAt.toISOString(),
        durationMs: finishedAt.getTime() - startedAt.getTime(),
        input: baseRecord.input,
        runPath,
        error: { message: err.message },
      }, context);
      err.statusCode = /timed out/i.test(err.message) ? 504 : 502;
      err.payload = { runId, runPath };
      throw err;
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
      const pathname = requestUrl.pathname;
      const requestContext = createRequestContext(request);
      response.setHeader('x-trace-id', requestContext.traceId);
      response.setHeader('x-tenant-id', requestContext.tenantId);
      response.setHeader('x-user-id', requestContext.userId);

      if (requiresOriginCheck(request.method, pathname) && !isAllowedOrigin(headerValue(request, 'origin'))) {
        sendJson(response, 403, { error: 'Origin not allowed' });
        return;
      }

      if (request.method === 'GET' && staticRoot && staticFiles.has(pathname)) {
        const asset = staticFiles.get(pathname);
        sendFile(response, path.join(staticRoot, asset.file), asset.type);
        return;
      }

      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { ok: true, service: 'kimi-cowork-host' });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/workspace') {
        sendJson(response, 200, {
          trustedRoot: trustedRootDefault,
          context: requestContext,
          kimiCli: {
            planEnabled: kimiCliPlanEnabled,
            chatEnabled: kimiCliPlanEnabled,
          },
        });
        return;
      }

      if (await handleRunRoutes({
        request,
        response,
        pathname,
        requestUrl,
        requestContext,
        runStoreRoot,
        runsIndex,
        runEvents,
      })) {
        return;
      }

      if (request.method === 'GET' && pathname === '/api/recipes') {
        sendJson(response, 200, {
          recipes: listRecipes(),
        });
        return;
      }

      if (await handleMemoryRoutes({
        request,
        response,
        pathname,
        requestUrl,
        requestContext,
        trustedRootDefault,
        memoryStore,
      })) {
        return;
      }

      if (request.method === 'GET' && pathname === '/api/kimi/info') {
        const info = await detectKimiInfo(config.kimiExecutable || 'kimi');
        sendJson(response, 200, info);
        return;
      }

      if (request.method === 'POST' && pathname === '/api/kimi/plan') {
        await withJsonBody(request, response, async (body) => {
          if (!kimiCliPlanEnabled) {
            sendJson(response, 503, {
              error: 'Kimi CLI plan is disabled. Set ENABLE_KIMI_CLI_PLAN=1 to enable it.',
            });
            return;
          }
          if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
            throw new Error('body.prompt is required');
          }
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          await runKimiAndRecord({
            type: 'kimi-plan',
            mode: body.mode === 'code' ? 'code' : 'cowork',
            trustedRoot: safeRoot,
            prompt: body.prompt,
            summary: body.summary,
            runner: kimiPlanRunner,
            response,
            context: requestContext,
          });
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/kimi/chat') {
        await withJsonBody(request, response, async (body) => {
          if (!kimiCliPlanEnabled) {
            sendJson(response, 503, {
              error: 'Kimi CLI chat is disabled. Set ENABLE_KIMI_CLI_PLAN=1 to enable it.',
            });
            return;
          }
          if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
            throw new Error('body.prompt is required');
          }
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          await runKimiAndRecord({
            type: 'kimi-chat',
            mode: 'chat',
            trustedRoot: safeRoot,
            prompt: body.prompt,
            summary: body.summary,
            runner: kimiChatRunner,
            response,
            context: requestContext,
          });
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/files/tree') {
        await withJsonBody(request, response, async (body) => {
          if (!body || typeof body.root !== 'string' || !body.root.trim()) {
            throw new Error('body.root is required');
          }
          const requestedRoot = path.resolve(body.root);
          const trustedRoot = assertTrustedPath(requestedRoot, trustedRootDefault);
          const tree = listWorkspaceTree(trustedRoot, {
            includeFiles: body.includeFiles !== false,
            includeDirectories: body.includeDirectories !== false,
          });
          sendJson(response, 200, { root: trustedRoot, files: tree });
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/uploads/import') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          const imported = importUploadedFiles({
            trustedRoot: safeRoot,
            files: body.files,
          });
          sendJson(response, 200, imported);
        }, { maxBytes: config.maxUploadJsonBytes || 18 * 1024 * 1024 });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/files/read') {
        await withJsonBody(request, response, async (body) => {
          if (!body || typeof body.path !== 'string' || !body.path.trim()) {
            throw new Error('body.path is required');
          }
          const trustedRoot = safeTrustedRoot(body.trustedRoot);
          const file = readTextFile(body.path, {
            trustedRoot,
            maxSize: body.maxSize,
          });
          sendJson(response, 200, file);
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/files/extract') {
        await withJsonBody(request, response, async (body) => {
          if (!body || typeof body.path !== 'string' || !body.path.trim()) {
            throw new Error('body.path is required');
          }
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          const extracted = extractDocumentText(body.path, {
            trustedRoot: safeRoot,
            maxSize: body.maxSize,
          });
          sendJson(response, 200, extracted);
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/files/search') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          const results = searchWorkspace({
            trustedRoot: safeRoot,
            query: body.query,
            maxResults: body.maxResults,
            includeContent: body.includeContent,
            maxContentBytes: body.maxContentBytes,
          });
          sendJson(response, 200, results);
        });
        return;
      }

      if (request.method === 'POST' && pathname.startsWith('/api/recipes/') && pathname.endsWith('/run')) {
        await withJsonBody(request, response, async (body) => {
          const recipeId = decodeURIComponent(pathname.slice('/api/recipes/'.length, -'/run'.length));
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
        return;
      }

      if (request.method === 'POST' && pathname === '/api/context/bundle') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = safeTrustedRoot(body.trustedRoot);
          if (!Array.isArray(body.paths)) {
            throw new Error('body.paths must be an array');
          }
          const bundle = buildContextBundle({
            root: trustedRoot,
            paths: body.paths,
            maxTextSize: body.maxTextSize,
            fsStatFn: (candidate) => {
              const safe = assertTrustedPath(candidate, trustedRoot);
              return fs.statSync(safe);
            },
          });
          sendJson(response, 200, bundle);
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/file-ops/preview') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = safeTrustedRoot(body.trustedRoot);
          const preview = previewFileOperations(body.operations, { trustedRoot });
          sendJson(response, 200, preview);
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/file-ops/apply') {
        await withJsonBody(request, response, async (body) => {
          if (!requireIdempotencyKey(response, requestContext)) {
            return;
          }
          const fingerprint = bodyFingerprint(body);
          const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
          if (sendCachedOrStore(response, cacheKey, fingerprint, 200)) {
            return;
          }
          const trustedRoot = safeTrustedRoot(body.trustedRoot);
          const applied = applyFileOperations(body.operations, {
            trustedRoot,
            journalWriter: config.journalWriter,
          });
          sendCachedOrStore(response, cacheKey, fingerprint, 200, {
            ...applied,
            context: requestContext,
          });
        });
        return;
      }

      if (await handleScheduleRoutes({
        request,
        response,
        pathname,
        requestUrl,
        requestContext,
        activeScheduler,
        cacheKeyFor,
        requireIdempotencyKey,
        sendCachedOrStore,
        safeTrustedRoot,
      })) {
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(response, 500, { error: err.message });
    }
  });

  return server;
}
