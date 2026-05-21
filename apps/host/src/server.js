import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
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
import { createRunId, listRunRecords, readRunRecord, writeRunRecord } from './runtime/run-store.js';
import { createRunsIndex, summariseRunForIndex } from './runtime/runs-index.js';
import { Scheduler, createScheduleStore } from './runtime/scheduler.js';
import { RunEventBus, formatSseFrame, parseLastEventId } from './runtime/run-events.js';
import { runRecipe } from './recipes/run-recipe.js';
import {
  createMemoryStore,
  MEMORY_LIMITS,
} from './memory/memory-store.js';
import { assertTrustedPath } from './security/path-policy.js';
import fs from 'node:fs';

const hostSrcDir = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = path.resolve(hostSrcDir, '../../windows-client/resources');
const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

function headerValue(request, name) {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

function stableHeader(value, fallback) {
  const text = String(value || '').trim();
  return /^[a-zA-Z0-9_.:-]{1,96}$/.test(text) ? text : fallback;
}

function createRequestContext(request) {
  const traceId = stableHeader(headerValue(request, 'x-trace-id'), `trace_${crypto.randomUUID()}`);
  return {
    traceId,
    tenantId: stableHeader(headerValue(request, 'x-tenant-id'), 'tenant_local'),
    userId: stableHeader(headerValue(request, 'x-user-id'), 'user_local'),
    idempotencyKey: stableHeader(headerValue(request, 'idempotency-key'), ''),
  };
}

function sendFile(response, filePath, contentType) {
  try {
    const body = fs.readFileSync(filePath);
    response.writeHead(200, {
      'content-type': contentType,
      'content-length': body.length,
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (err) {
    sendJson(response, 404, { error: `Static asset not found: ${err.message}` });
  }
}

function readJsonBody(request, { maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let rejected = false;
    request.on('data', (chunk) => {
      if (rejected) {
        return;
      }
      raw += chunk.toString();
      if (raw.length > maxBytes) {
        rejected = true;
        reject(new Error(`Request body too large; max ${maxBytes} bytes`));
        request.destroy();
      }
    });
    request.on('end', () => {
      if (rejected) {
        return;
      }
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    request.on('error', reject);
  });
}

function taskFromRun(run) {
  const status = run.status === 'succeeded' ? 'done' : run.status === 'failed' ? 'failed' : 'in_progress';
  return {
    id: run.id,
    status,
    activeForm: status === 'in_progress' ? '任务运行中' : status === 'failed' ? '需要查看错误' : '已完成',
    prompt: run.prompt,
    mode: run.mode,
    type: run.type,
    provider: run.provider,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    summary: run.summary,
  };
}

async function withJsonBody(request, response, handler, options = {}) {
  let body;
  try {
    body = await readJsonBody(request, options);
  } catch (err) {
    sendJson(response, 400, { error: `Invalid JSON body: ${err.message}` });
    return;
  }
  try {
    await handler(body);
  } catch (err) {
    sendJson(response, err.statusCode || 400, {
      error: err.message,
      ...(err.payload || {}),
    });
  }
}

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
        trustedRoot: payload.trustedRoot || trustedRootDefault,
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

  function cacheKeyFor(context, method, pathname) {
    if (!context.idempotencyKey) {
      return '';
    }
    return `${context.tenantId}:${context.userId}:${method}:${pathname}:${context.idempotencyKey}`;
  }

  function sendCachedOrStore(response, cacheKey, status, payload) {
    if (cacheKey && idempotencyStore.has(cacheKey)) {
      const cached = idempotencyStore.get(cacheKey);
      sendJson(response, cached.status, {
        ...cached.payload,
        idempotentReplay: true,
      });
      return;
    }
    if (cacheKey) {
      idempotencyStore.set(cacheKey, {
        status,
        payload,
      });
    }
    sendJson(response, status, payload);
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

      if (request.method === 'GET' && pathname === '/api/tasks') {
        const runs = listRunRecords(runStoreRoot, {
          limit: Number(requestUrl.searchParams.get('limit')) || 20,
        });
        sendJson(response, 200, {
          runStoreRoot,
          tasks: runs.map(taskFromRun),
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/recipes') {
        sendJson(response, 200, {
          recipes: listRecipes(),
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/memory') {
        const trustedRoot = path.resolve(
          requestUrl.searchParams.get('trustedRoot') || trustedRootDefault,
        );
        const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
        const main = memoryStore.readMainMemory(safeRoot, requestContext);
        const notes = memoryStore.listMemoryNotes(safeRoot, requestContext).map((note) => ({
          name: note.name,
          size: note.size,
          modifiedAt: note.modifiedAt,
        }));
        sendJson(response, 200, {
          trustedRoot: safeRoot,
          memory: {
            enabled: Boolean(main.trim()),
            bytes: Buffer.byteLength(main, 'utf8'),
            text: main,
            notes,
          },
          limits: MEMORY_LIMITS,
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/memory/facts') {
        await withJsonBody(request, response, async (body) => {
          const trustedRoot = path.resolve(body?.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          const result = memoryStore.appendMemoryFact(
            safeRoot,
            { key: body?.key, value: body?.value, scope: body?.scope },
            requestContext,
          );
          sendJson(response, 200, {
            trustedRoot: safeRoot,
            fact: result.fact,
            file: result.file,
            context: requestContext,
          });
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/memory/notes') {
        await withJsonBody(request, response, async (body) => {
          if (!body || typeof body.name !== 'string' || !body.name.trim()) {
            throw new Error('body.name is required');
          }
          if (typeof body.body !== 'string') {
            throw new Error('body.body must be a string');
          }
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
          const written = memoryStore.writeMemoryNote(safeRoot, body.name, body.body, requestContext);
          sendJson(response, 200, {
            trustedRoot: safeRoot,
            note: { name: body.name, path: written },
            context: requestContext,
          });
        });
        return;
      }

      if (request.method === 'GET' && pathname.startsWith('/api/memory/notes/')) {
        const noteName = decodeURIComponent(pathname.slice('/api/memory/notes/'.length));
        const trustedRoot = path.resolve(
          requestUrl.searchParams.get('trustedRoot') || trustedRootDefault,
        );
        const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
        const body = memoryStore.readMemoryNote(safeRoot, noteName, requestContext);
        if (body == null) {
          sendJson(response, 404, { error: 'Memory note not found' });
          return;
        }
        sendJson(response, 200, {
          trustedRoot: safeRoot,
          note: { name: noteName, body },
        });
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

      if (request.method === 'GET' && pathname === '/api/runs/index') {
        const limit = Number(requestUrl.searchParams.get('limit')) || 50;
        const status = requestUrl.searchParams.get('status') || undefined;
        const type = requestUrl.searchParams.get('type') || undefined;
        const recipeId = requestUrl.searchParams.get('recipeId') || undefined;
        const userId = requestUrl.searchParams.get('userId') || undefined;
        const records = runsIndex.list({
          tenantId: requestContext.tenantId,
          userId,
          limit,
          status,
          type,
          recipeId,
        });
        sendJson(response, 200, {
          context: requestContext,
          stats: runsIndex.stats({ tenantId: requestContext.tenantId }),
          runs: records,
        });
        return;
      }

      if (request.method === 'GET' && pathname.startsWith('/api/runs/') && pathname.endsWith('/events')) {
        const runId = decodeURIComponent(pathname.slice('/api/runs/'.length, -'/events'.length));
        if (!/^[a-z0-9_-]+$/i.test(runId)) {
          sendJson(response, 400, { error: 'Invalid run id' });
          return;
        }
        const lastEventId = parseLastEventId(
          headerValue(request, 'last-event-id') || requestUrl.searchParams.get('lastEventId'),
        );
        let persisted = [];
        try {
          const record = readRunRecord(runStoreRoot, runId);
          if (record && Array.isArray(record.events)) {
            persisted = record.events;
          }
        } catch {
          persisted = [];
        }
        runEvents.seed(runId, persisted);

        response.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-trace-id': requestContext.traceId,
          'x-tenant-id': requestContext.tenantId,
        });
        response.write('retry: 3000\n\n');

        const sentSeqs = new Set();
        const writeEvent = (event) => {
          if (event.seq != null) {
            if (sentSeqs.has(event.seq)) {
              return;
            }
            sentSeqs.add(event.seq);
          }
          response.write(formatSseFrame(event));
        };

        for (const event of persisted) {
          if ((Number(event.seq) || 0) > lastEventId) {
            writeEvent(event);
          }
        }
        for (const event of runEvents.replay(runId, lastEventId)) {
          writeEvent(event);
        }

        const unsubscribe = runEvents.subscribe(runId, (event) => {
          writeEvent(event);
        });
        const heartbeat = setInterval(() => {
          response.write(': ping\n\n');
        }, 15000);
        if (heartbeat && typeof heartbeat.unref === 'function') {
          heartbeat.unref();
        }
        const cleanup = () => {
          clearInterval(heartbeat);
          unsubscribe();
        };
        request.on('close', cleanup);
        response.on('close', cleanup);
        return;
      }

      if (request.method === 'GET' && pathname === '/api/runs') {
        sendJson(response, 200, {
          runStoreRoot,
          runs: listRunRecords(runStoreRoot, {
            limit: Number(requestUrl.searchParams.get('limit')) || 20,
          }),
        });
        return;
      }

      if (request.method === 'GET' && pathname.startsWith('/api/runs/')) {
        const runId = decodeURIComponent(pathname.slice('/api/runs/'.length));
        const run = readRunRecord(runStoreRoot, runId);
        if (!run) {
          sendJson(response, 404, { error: 'Run record not found' });
          return;
        }
        sendJson(response, 200, run);
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
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
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
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const safeRoot = assertTrustedPath(trustedRoot, trustedRootDefault);
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
          sendJson(response, 200, {
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
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
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
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const preview = previewFileOperations(body.operations, { trustedRoot });
          sendJson(response, 200, preview);
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/file-ops/apply') {
        await withJsonBody(request, response, async (body) => {
          const cacheKey = cacheKeyFor(requestContext, request.method, pathname);
          if (cacheKey && idempotencyStore.has(cacheKey)) {
            const cached = idempotencyStore.get(cacheKey);
            sendJson(response, cached.status, {
              ...cached.payload,
              idempotentReplay: true,
            });
            return;
          }
          const trustedRoot = path.resolve(body.trustedRoot || trustedRootDefault);
          const applied = applyFileOperations(body.operations, {
            trustedRoot,
            journalWriter: config.journalWriter,
          });
          sendCachedOrStore(response, cacheKey, 200, {
            ...applied,
            context: requestContext,
          });
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/schedules') {
        const userId = requestUrl.searchParams.get('userId') || undefined;
        const list = activeScheduler ? activeScheduler.list({
          tenantId: requestContext.tenantId,
          userId,
        }) : [];
        sendJson(response, 200, {
          context: requestContext,
          schedules: list,
          enabled: Boolean(activeScheduler),
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/schedules') {
        await withJsonBody(request, response, async (body) => {
          if (!activeScheduler) {
            sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
            return;
          }
          const record = activeScheduler.create({
            name: body?.name,
            cron: body?.cron,
            fireAt: body?.fireAt,
            payload: body?.payload || {},
            tenantId: requestContext.tenantId,
            userId: requestContext.userId,
            traceId: requestContext.traceId,
            idempotencyKey: requestContext.idempotencyKey,
          });
          sendJson(response, 200, { schedule: record, context: requestContext });
        });
        return;
      }

      if (request.method === 'POST' && pathname.startsWith('/api/schedules/') && pathname.endsWith('/cancel')) {
        if (!activeScheduler) {
          sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
          return;
        }
        const id = decodeURIComponent(pathname.slice('/api/schedules/'.length, -'/cancel'.length));
        const ok = activeScheduler.cancel(id);
        if (!ok) {
          sendJson(response, 404, { error: 'Schedule not found' });
          return;
        }
        sendJson(response, 200, { ok: true, schedule: activeScheduler.get(id) });
        return;
      }

      if (request.method === 'DELETE' && pathname.startsWith('/api/schedules/')) {
        if (!activeScheduler) {
          sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
          return;
        }
        const id = decodeURIComponent(pathname.slice('/api/schedules/'.length));
        const ok = activeScheduler.remove(id);
        if (!ok) {
          sendJson(response, 404, { error: 'Schedule not found' });
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/schedules/_tick') {
        if (!activeScheduler) {
          sendJson(response, 503, { error: 'Scheduler is not enabled in this host.' });
          return;
        }
        const results = await activeScheduler.tickOnce();
        sendJson(response, 200, {
          ok: true,
          fired: results.length,
          results: results.map((r) => ({ ok: r.ok, scheduleId: r.schedule?.id, runId: r.schedule?.lastRunId })),
        });
        return;
      }

      sendJson(response, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(response, 500, { error: err.message });
    }
  });

  return server;
}
