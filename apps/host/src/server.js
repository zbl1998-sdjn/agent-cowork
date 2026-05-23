import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveKimiApiConfig, runKimiApiChat, runKimiApiPlan, runKimiApiChatStream } from './kimi/api-runner.js';
import { streamChat } from './kimi/chat-stream.js';
import { streamAgentChat, modelBreakerStats } from './kimi/agent-runner.js';
import { createRunId, writeRunRecord } from './runtime/run-store.js';
import { createRunsIndex, summariseRunForIndex } from './runtime/runs-index.js';
import { createPostgresRunsIndex, withSafeWrites } from './storage/postgres-runs-index.js';
import { Scheduler, createScheduleStore } from './runtime/scheduler.js';
import { RunEventBus } from './runtime/run-events.js';
import { runRecipe } from './recipes/run-recipe.js';
import { createMemoryStore } from './memory/memory-store.js';
import { assertTrustedPath } from './security/path-policy.js';
import { handleMemoryRoutes } from './routes/memory-routes.js';
import { createConversationStore } from './storage/conversation-store.js';
import { createPostgresConversationStore } from './storage/postgres-conversation-store.js';
import { handleConversationRoutes } from './routes/conversation-routes.js';
import { handleRunRoutes } from './routes/run-routes.js';
import { handleRecipeRoutes } from './routes/recipe-routes.js';
import { handleScheduleRoutes } from './routes/schedule-routes.js';
import { handleWorkspaceFileRoutes } from './routes/workspace-file-routes.js';
import { handleArtifactRoutes } from './routes/artifact-routes.js';
import { handleSandboxRoutes } from './routes/sandbox-routes.js';
import { handleToolRoutes } from './routes/tool-routes.js';
import { handleVizRoutes } from './routes/viz-routes.js';
import { createSandbox, DEFAULT_ALLOW_TOOLS } from './sandbox/index.js';
import { createToolRegistry } from './tools/tool-registry.js';
import { createBuiltinTools } from './tools/builtin-tools.js';
import { connectMcpServers, closeMcpClients } from './mcp/connect.js';
import { createSkillRegistry } from './skills/skill-registry.js';
import { createCancellationRegistry } from './runtime/cancellation.js';
import { resolveJwtIdentity } from './auth/jwt.js';
import { createPostgresApprovalStore } from './storage/postgres-approvals.js';
import { createPostgresEventBus } from './storage/postgres-event-bus.js';
import { createPostgresMemoryStore } from './storage/postgres-memory-store.js';
import { createCachedPostgresScheduleStore } from './storage/cached-pg-schedule-store.js';
import { createConcurrencyLimiter } from './runtime/concurrency.js';
import { createRateLimiter } from './runtime/rate-limit.js';
import { redactText } from './security/redaction.js';
import { createApprovalRegistry } from './runtime/approvals.js';
import { handleSkillRoutes } from './routes/skill-routes.js';
import { handlePlanRoutes } from './routes/plan-routes.js';
import { createClarificationStore } from './runtime/clarifications.js';
import { handleClarifyRoutes } from './routes/clarify-routes.js';
import { handleConnectorRoutes } from './routes/connector-routes.js';
import { createUserStore } from './auth/user-store.js';
import { createSqliteUserStore } from './auth/sqlite-user-store.js';
import { handleAuthRoutes } from './routes/auth-routes.js';
import {
  createRequestContext,
  headerValue,
  isAllowedOrigin,
  requiresOriginCheck,
  sendFile,
  sendJson,
  stableHeader,
  withJsonBody,
} from './http/request-utils.js';

// Hardening headers sent on every response (see security probe findings).
const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

// The only /api routes reachable without a verified identity. Everything else is
// gated by the auth check (see requireAuth). /health is exempt as it's not /api.
const PUBLIC_API_ROUTES = [
  ['POST', '/api/auth/register'],
  ['POST', '/api/auth/login'],
  ['POST', '/api/auth/guest'],
];
function isPublicApiRoute(method, pathname) {
  return PUBLIC_API_ROUTES.some(([m, p]) => m === method && p === pathname);
}

const hostSrcDir = path.dirname(fileURLToPath(import.meta.url));
const defaultStaticRoot = path.resolve(hostSrcDir, '../../windows-client/resources');
const staticFiles = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.css', { file: 'app.css', type: 'text/css; charset=utf-8' }],
  ['/app-utils.js', { file: 'app-utils.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-api-client.js', { file: 'app-api-client.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-run-events.js', { file: 'app-run-events.js', type: 'text/javascript; charset=utf-8' }],
  ['/app-composer-popover.js', { file: 'app-composer-popover.js', type: 'text/javascript; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
]);

function applyPersistedKimiConfig(file, target) {
  try {
    if (!fs.existsSync(file)) return;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const kimi = raw && typeof raw === 'object' ? (raw.kimiApi || raw.kimi || raw) : null;
    if (!kimi || typeof kimi !== 'object') return;
    if (typeof kimi.apiKey === 'string' && kimi.apiKey.trim()) target.apiKey = kimi.apiKey.trim();
    if (typeof kimi.baseUrl === 'string' && kimi.baseUrl.trim()) target.baseUrl = kimi.baseUrl.trim().replace(/\/+$/, '');
    if (typeof kimi.model === 'string' && kimi.model.trim()) target.model = kimi.model.trim();
    target.configured = Boolean(target.apiKey);
  } catch {
    // Corrupt config file -> ignore and fall back to env-derived config.
  }
}

function persistKimiConfig(file, source) {
  const payload = {
    kimiApi: {
      apiKey: source.apiKey || '',
      baseUrl: source.baseUrl || '',
      model: source.model || '',
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

export function createServer(config = {}) {
  const trustedRootDefault = path.resolve(config.trustedRoot || process.env.TRUSTED_ROOT || process.cwd());
  const staticRoot = config.staticRoot === false ? null : path.resolve(config.staticRoot || defaultStaticRoot);
  // Prefer the built React UI (single conversational flow) when present; the
  // legacy multi-mode static UI under resources/ is deprecated and only used as
  // a fallback until ui-dist is built.
  const uiDistRoot = path.resolve(config.uiDistRoot || path.join(hostSrcDir, '../../windows-client/ui-dist'));
  const uiDistEnabled = config.uiDist !== false && fs.existsSync(path.join(uiDistRoot, 'index.html'));
  const UI_DIST_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
    '.txt': 'text/plain; charset=utf-8',
  };
  function serveFromUiDist(response, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const candidate = path.resolve(uiDistRoot, rel);
    const inside = candidate === uiDistRoot || candidate.startsWith(uiDistRoot + path.sep);
    if (!inside) {
      return false;
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      sendFile(response, candidate, UI_DIST_TYPES[path.extname(candidate).toLowerCase()] || 'application/octet-stream');
      return true;
    }
    // SPA fallback: a route with no file extension -> serve index.html.
    if (!path.extname(rel)) {
      sendFile(response, path.join(uiDistRoot, 'index.html'), 'text/html; charset=utf-8');
      return true;
    }
    return false;
  }
  const kimiConfigFile = path.resolve(
    config.kimiConfigFile || path.join(trustedRootDefault, '.AgentCowork', 'config.json'),
  );
  const kimiApiConfig = resolveKimiApiConfig(config);
  // Persisted overrides (.AgentCowork/config.json) win over env so a key entered
  // via the API settings panel survives restarts.
  applyPersistedKimiConfig(kimiConfigFile, kimiApiConfig);
  function recomputeKimiEnabled() {
    return config.enableKimiApi !== false
      && (kimiApiConfig.configured || Boolean(config.kimiPlanRunner) || Boolean(config.kimiChatRunner));
  }
  let kimiApiEnabled = recomputeKimiEnabled();
  const kimiPlanRunner = config.kimiPlanRunner || runKimiApiPlan;
  const kimiChatRunner = config.kimiChatRunner || runKimiApiChat;
  const kimiChatStreamRunner = config.kimiChatStreamRunner || runKimiApiChatStream;
  const runStoreRoot = path.resolve(config.runStoreRoot || path.join(trustedRootDefault, '.AgentCowork', 'runs'));
  const idempotencyStore = config.idempotencyStore || new Map();
  const runsIndexRoot = path.resolve(config.runsIndexRoot || path.join(trustedRootDefault, '.AgentCowork', 'index'));
  const storeRaw = String(config.storeBackend || process.env.KCW_STORE || 'file').toLowerCase();
  const storeBackend = storeRaw === 'sqlite' ? 'sqlite' : storeRaw === 'postgres' ? 'postgres' : 'file';
  const databaseUrl = config.databaseUrl || process.env.DATABASE_URL || null;
  const usePostgresState = storeBackend === 'postgres' && !!databaseUrl;
  const sqliteDbPath = path.resolve(
    config.sqliteDbPath || process.env.KCW_SQLITE_PATH || path.join(trustedRootDefault, '.AgentCowork', 'state.sqlite'),
  );
  const runsIndex = config.runsIndex || (storeBackend === 'postgres'
    ? withSafeWrites(createPostgresRunsIndex({ connectionString: databaseUrl }))
    : createRunsIndex({ backend: storeBackend, indexRoot: runsIndexRoot, dbPath: sqliteDbPath }));
  const memoryStore = config.memoryStore || (usePostgresState
    ? createPostgresMemoryStore({ connectionString: databaseUrl })
    : createMemoryStore({ backend: storeBackend, dbPath: sqliteDbPath }));
  const conversationStore = config.conversationStore || (usePostgresState
    ? createPostgresConversationStore({ connectionString: databaseUrl })
    : createConversationStore({ backend: storeBackend }));
  const runEvents = config.runEventBus || (usePostgresState ? createPostgresEventBus({ connectionString: databaseUrl }) : new RunEventBus());
  const sandboxEnabled = config.enableSandbox !== false;
  const sandbox = config.sandbox || createSandbox({
    backend: config.sandboxBackend || process.env.KCW_SANDBOX_BACKEND || 'local',
    ...(config.sandboxOptions || {}),
  });
  const sandboxLimits = {
    allowTools: config.sandboxAllowTools || DEFAULT_ALLOW_TOOLS,
    allowEnv: config.sandboxAllowEnv || [],
    maxTimeoutMs: config.sandboxMaxTimeoutMs,
    defaultMaxOutputBytes: config.sandboxMaxOutputBytes,
  };
  const toolRegistry = config.toolRegistry || createToolRegistry().registerMany(
    createBuiltinTools({
      sandbox: sandboxEnabled ? sandbox : null,
      sandboxLimits,
      runStoreRoot,
      runEvents,
      runsIndex,
    }),
  );
  const skillRegistry = config.skillRegistry || createSkillRegistry();
  const cancellation = config.cancellation || createCancellationRegistry();
  const approvalRegistry = config.approvalRegistry || (usePostgresState ? createPostgresApprovalStore({ connectionString: databaseUrl }) : createApprovalRegistry());
  // Multi-instance (Postgres) mode: open the LISTEN connections so approvals
  // resolved on a peer instance and run events from peers are delivered here.
  if (usePostgresState) {
    if (approvalRegistry && typeof approvalRegistry.start === 'function') Promise.resolve(approvalRegistry.start()).catch(() => {});
    if (runEvents && typeof runEvents.start === 'function') Promise.resolve(runEvents.start()).catch(() => {});
  }
  const agentConcurrency = config.agentConcurrency || createConcurrencyLimiter({
    maxConcurrent: Number(process.env.KCW_MAX_CONCURRENT_RUNS || 64),
    maxPerTenant: Number(process.env.KCW_MAX_RUNS_PER_TENANT || 8),
  });
  // Per-tenant HTTP rate limiter (requests/sec). Complements agentConcurrency
  // (which caps simultaneous streams). Set config.rateLimit=false to disable.
  const rateLimiter = config.rateLimit === false ? null : (config.rateLimiter || createRateLimiter({
    ratePerSec: Number(config.rateLimitPerSec || process.env.KCW_RATE_PER_SEC || 50),
    burst: Number(config.rateLimitBurst || process.env.KCW_RATE_BURST || 100),
  }));
  let draining = false;
  const clarifications = config.clarifications || createClarificationStore();
  // Auth store: persist users/sessions/guest tenants across restarts by default
  // (SQLite, gracefully degrades to in-memory if node:sqlite is unavailable).
  // Set config.persistAuth=false / KCW_AUTH_PERSIST=false for ephemeral hosts
  // and tests that don't want to touch disk.
  const authDbPath = path.resolve(
    config.authDbPath || process.env.KCW_AUTH_DB || path.join(trustedRootDefault, '.AgentCowork', 'auth.sqlite'),
  );
  const persistAuth = config.persistAuth ?? (process.env.KCW_AUTH_PERSIST !== 'false');
  const authStore = config.authStore || (persistAuth ? createSqliteUserStore({ dbPath: authDbPath }) : createUserStore());
  const jwtSecret = config.jwtSecret || process.env.KCW_JWT_SECRET || null;
  // Auth gate (P0): every /api route except the public auth endpoints requires a
  // verified identity. Default ON; opt out with config.requireAuth=false or
  // KCW_REQUIRE_AUTH=false (e.g. for functional tests). `trustIdentityHeaders`
  // (default OFF) re-enables x-tenant-id/x-user-id only behind a trusted proxy.
  const requireAuth = config.requireAuth ?? (process.env.KCW_REQUIRE_AUTH !== 'false');
  // Explicit config wins over the env fallback (so a test can force the gate
  // semantics regardless of the suite-wide KCW_TRUST_IDENTITY_HEADERS preload).
  const trustIdentityHeaders = config.trustIdentityHeaders ?? (process.env.KCW_TRUST_IDENTITY_HEADERS === 'true');
  const scheduleStoreDir = path.resolve(config.scheduleStoreDir || path.join(trustedRootDefault, '.AgentCowork', 'schedules'));
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
      store: config.scheduleStore || (usePostgresState
        ? createCachedPostgresScheduleStore({ connectionString: databaseUrl })
        : createScheduleStore({ backend: storeBackend, storeDir: scheduleStoreDir, dbPath: sqliteDbPath })),
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
      provider: 'kimi-api',
      model: kimiApiConfig.model,
      baseUrl: kimiApiConfig.baseUrl,
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
        trustedRoot,
        prompt,
        summary,
        mode,
        memory: memoryContext.text,
        apiKey: kimiApiConfig.apiKey,
        baseUrl: kimiApiConfig.baseUrl,
        timeoutMs: kimiApiConfig.timeoutMs,
        maxTokens: kimiApiConfig.maxTokens,
        model: kimiApiConfig.model,
        userAgent: kimiApiConfig.userAgent,
        temperature: kimiApiConfig.temperature,
        fetchImpl: config.fetchImpl,
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
          provider: result.provider || baseRecord.provider,
          model: result.model || baseRecord.model,
          usage: result.usage || null,
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
      const authHeader = headerValue(request, 'authorization');
      if (authHeader && authHeader.startsWith('Bearer ')) {
        const token = authHeader.slice(7);
        // Stateless JWT first (works across instances); fall back to opaque session.
        let session = jwtSecret ? resolveJwtIdentity(token, jwtSecret) : null;
        if (!session) session = authStore.resolveToken(token);
        if (session) {
          // A valid token is the ONLY thing that marks a request authenticated
          // and sets its tenant/user. This is what the /api gate checks.
          requestContext.authenticated = true;
          if (session.userId) requestContext.userId = session.userId;
          if (session.tenantId) requestContext.tenantId = session.tenantId;
        }
      }
      // Escape hatch for tests / a trusted reverse proxy: allow identity headers
      // only when explicitly enabled. Off by default — never trust them in prod.
      if (!requestContext.authenticated && trustIdentityHeaders) {
        const t = stableHeader(headerValue(request, 'x-tenant-id'), '');
        const u = stableHeader(headerValue(request, 'x-user-id'), '');
        if (t) requestContext.tenantId = t;
        if (u) requestContext.userId = u;
        requestContext.authenticated = true;
      }
      response.setHeader('x-trace-id', requestContext.traceId);
      response.setHeader('x-tenant-id', requestContext.tenantId);
      response.setHeader('x-user-id', requestContext.userId);
      // Defense-in-depth response headers applied to every response. The host is
      // a loopback API for the desktop shell, so these are conservative:
      //  - nosniff:        never MIME-sniff (blocks content-type confusion)
      //  - DENY framing:    the API/UI must not be embedded in a foreign frame
      //  - no-referrer:     never leak URLs to other origins
      //  - COOP/CORP:       isolate this origin's browsing context + resources
      for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        response.setHeader(name, value);
      }

      // CORS for loopback origins (browser preview at :5173 and the Tauri
      // webview both fetch the host cross-origin). Only origins vetted by
      // isAllowedOrigin (loopback http/https + tauri:) are reflected.
      const requestOrigin = headerValue(request, 'origin');
      const originOk = isAllowedOrigin(requestOrigin);
      if (requestOrigin && originOk) {
        response.setHeader('access-control-allow-origin', requestOrigin);
        response.setHeader('vary', 'Origin');
        response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
        // `authorization` MUST be here: every authenticated request carries a
        // Bearer token, which makes the browser send a CORS preflight asking to
        // use the `authorization` header. If we don't echo it back in
        // allow-headers, the webview silently blocks the request — guest login
        // (no token) succeeds, but every signed-in call (kimi/info, workspace,
        // conversations…) fails, surfacing as a misleading "configure API" hint.
        response.setHeader('access-control-allow-headers', 'authorization,content-type,accept,idempotency-key,x-tenant-id,x-user-id,x-trace-id,last-event-id');
        response.setHeader('access-control-max-age', '600');
      }
      if (request.method === 'OPTIONS') {
        response.writeHead(originOk ? 204 : 403);
        response.end();
        return;
      }

      if (requiresOriginCheck(request.method, pathname) && !isAllowedOrigin(headerValue(request, 'origin'))) {
        sendJson(response, 403, { error: 'Origin not allowed' });
        return;
      }

      // Per-tenant HTTP rate limit (gap #1). Applies to the /api surface only —
      // /health and static UI assets are exempt so monitoring and the shell are
      // never throttled. Emits standard X-RateLimit-* headers; 429 + Retry-After
      // when the tenant's token bucket is empty.
      if (rateLimiter && pathname.startsWith('/api/')) {
        const rl = rateLimiter.take(requestContext.tenantId);
        response.setHeader('X-RateLimit-Limit', String(rl.limit));
        response.setHeader('X-RateLimit-Remaining', String(rl.remaining));
        if (!rl.allowed) {
          response.setHeader('Retry-After', String(rl.retryAfterSec));
          sendJson(response, 429, { error: 'rate limit exceeded; slow down', retryAfterSec: rl.retryAfterSec });
          return;
        }
      }

      // Auth gate (P0): the /api surface requires a verified identity, except the
      // public auth endpoints (register/login/guest). Without this an unauthed
      // caller could read/write the trusted root. /health and static UI are not
      // under /api so they stay reachable for monitoring + first paint.
      if (requireAuth && pathname.startsWith('/api/') && !isPublicApiRoute(request.method, pathname) && !requestContext.authenticated) {
        sendJson(response, 401, { error: 'authentication required' });
        return;
      }

      if (request.method === 'GET' && uiDistEnabled && pathname !== '/health' && pathname !== '/metrics' && !pathname.startsWith('/api/')) {
        if (serveFromUiDist(response, pathname)) {
          return;
        }
      }

      if (request.method === 'GET' && staticRoot && staticFiles.has(pathname)) {
        const asset = staticFiles.get(pathname);
        sendFile(response, path.join(staticRoot, asset.file), asset.type);
        return;
      }

      if (request.method === 'GET' && pathname === '/health') {
        sendJson(response, 200, { ok: true, service: 'agent-cowork-host' });
        return;
      }

      // Minimal Prometheus metrics. Not under /api/, so (like /health) it's
      // exempt from the auth gate + rate limit for monitoring/scraping. Exposes
      // only operational gauges — no secrets, no per-request payloads.
      if (request.method === 'GET' && pathname === '/metrics') {
        const c = agentConcurrency.stats();
        const rl = rateLimiter ? rateLimiter.stats() : { tenants: 0 };
        let breakers = [];
        try { breakers = modelBreakerStats(); } catch { breakers = []; }
        const openBreakers = breakers.filter((b) => b.state === 'open').length;
        const mem = process.memoryUsage();
        const body = [
          '# HELP kcw_uptime_seconds Host process uptime in seconds.',
          '# TYPE kcw_uptime_seconds gauge',
          `kcw_uptime_seconds ${Math.floor(process.uptime())}`,
          '# HELP kcw_concurrency_active Active agent streams.',
          '# TYPE kcw_concurrency_active gauge',
          `kcw_concurrency_active ${c.active}`,
          `kcw_concurrency_max ${c.maxConcurrent}`,
          `kcw_concurrency_tenants ${c.tenants}`,
          '# HELP kcw_ratelimit_tenants Tenants with an active rate-limit bucket.',
          '# TYPE kcw_ratelimit_tenants gauge',
          `kcw_ratelimit_tenants ${rl.tenants || 0}`,
          '# HELP kcw_model_breakers_open Open model circuit breakers.',
          '# TYPE kcw_model_breakers_open gauge',
          `kcw_model_breakers_open ${openBreakers}`,
          '# HELP kcw_draining Whether the host is draining for shutdown (1/0).',
          '# TYPE kcw_draining gauge',
          `kcw_draining ${draining ? 1 : 0}`,
          '# HELP process_resident_memory_bytes Resident set size in bytes.',
          '# TYPE process_resident_memory_bytes gauge',
          `process_resident_memory_bytes ${mem.rss}`,
          '',
        ].join('\n');
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', ...SECURITY_HEADERS });
        response.end(body);
        return;
      }

      // Security/resilience self-check. Reports posture without exposing secrets
      // (the API key surfaces only as configured/hasKey booleans) so the UI can
      // render a red/green dashboard and ops can curl it.
      if (request.method === 'GET' && pathname === '/api/selfcheck') {
        let breakers = [];
        try { breakers = modelBreakerStats(); } catch { breakers = []; }
        const rateLimit = rateLimiter ? { enabled: true, ...rateLimiter.stats() } : { enabled: false };
        const checks = [];
        const add = (id, ok, detail) => checks.push({ id, status: ok ? 'pass' : 'warn', detail });
        add('security-headers', true, Object.keys(SECURITY_HEADERS).join(', '));
        add('cors-loopback-only', true, 'only loopback http/https + tauri: origins reflected');
        add('api-key', kimiApiConfig.configured, kimiApiConfig.configured ? 'configured (never echoed)' : '未配置 API Key');
        add('rate-limit', Boolean(rateLimiter), rateLimiter ? `${rateLimit.ratePerSec}/s · burst ${rateLimit.burst}` : '限流未启用');
        add('model-circuit', !breakers.some((b) => b.state === 'open'), breakers.length ? breakers.map((b) => `${b.name}:${b.state}`).join(', ') : '尚无模型调用');
        add('accepting-requests', !draining, draining ? '正在优雅停机' : '正常受理请求');
        sendJson(response, 200, {
          service: 'agent-cowork-host',
          time: new Date().toISOString(),
          security: {
            responseHeaders: Object.keys(SECURITY_HEADERS),
            cors: 'loopback+tauri only',
            apiKey: { configured: kimiApiConfig.configured, hasKey: Boolean(kimiApiConfig.apiKey) },
            bodyLimitBytes: 1024 * 1024,
          },
          resilience: { rateLimit, concurrency: agentConcurrency.stats(), modelBreakers: breakers, draining },
          storage: { backend: storeBackend, postgres: usePostgresState },
          checks,
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/workspace') {
        sendJson(response, 200, {
          trustedRoot: trustedRootDefault,
          context: requestContext,
          kimiApi: {
            provider: 'kimi-api',
            configured: kimiApiConfig.configured,
            planEnabled: kimiApiEnabled,
            chatEnabled: kimiApiEnabled,
            baseUrl: kimiApiConfig.baseUrl,
            model: kimiApiConfig.model,
          },
          kimiCli: {
            planEnabled: false,
            chatEnabled: false,
            legacy: true,
          },
        });
        return;
      }

      if (request.method === 'POST' && /^\/api\/runs\/[a-zA-Z0-9_-]+\/cancel$/.test(pathname)) {
        const id = pathname.split('/')[3];
        sendJson(response, 200, { context: requestContext, runId: id, cancelled: cancellation.cancel(id) });
        return;
      }

      // ── Route dispatch chain ──────────────────────────────────────────────
      // Each handler inspects (method, pathname) and returns true if it owns the
      // request (and has already responded), or false to fall through to the next
      // one. Auth/CORS/security-headers were applied above the chain, so handlers
      // only deal with their own paths. Order matters only where prefixes overlap;
      // keep narrow/specific handlers before broad fallbacks. See docs/EXTENDING.md.
      if (await handleAuthRoutes({ request, response, pathname, requestContext, authStore })) {
        return;
      }

      if (request.method === 'POST' && /^\/api\/approvals\/[a-zA-Z0-9_-]+$/.test(pathname)) {
        await withJsonBody(request, response, async (body) => {
          const id = pathname.split('/')[3];
          // AskUserQuestion answers carry a free-form { answer }; approvals carry { decision }.
          const hasAnswer = body && typeof body.answer !== 'undefined';
          const ok = hasAnswer
            ? await approvalRegistry.respond(id, body.answer)
            : await approvalRegistry.resolve(id, body && body.decision);
          sendJson(response, ok ? 200 : 404, { context: requestContext, id, ok, decision: body && body.decision, answer: hasAnswer ? body.answer : undefined });
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

      if (await handleRecipeRoutes({
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
      })) {
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

      if (await handleConversationRoutes({
        request,
        response,
        pathname,
        requestUrl,
        requestContext,
        trustedRootDefault,
        conversationStore,
      })) {
        return;
      }

      if (await handleArtifactRoutes({
        request,
        response,
        pathname,
        requestUrl,
        requestContext,
        trustedRootDefault,
        safeTrustedRoot,
      })) {
        return;
      }

      if (request.method === 'POST' && pathname === '/api/kimi/config') {
        await withJsonBody(request, response, async (body) => {
          const next = body && typeof body === 'object' ? body : {};
          if (next.clearKey === true) {
            kimiApiConfig.apiKey = '';
          } else if (typeof next.apiKey === 'string' && next.apiKey.trim()) {
            kimiApiConfig.apiKey = next.apiKey.trim();
          }
          if (typeof next.baseUrl === 'string' && next.baseUrl.trim()) {
            kimiApiConfig.baseUrl = next.baseUrl.trim().replace(/\/+$/, '');
          }
          if (typeof next.model === 'string' && next.model.trim()) {
            kimiApiConfig.model = next.model.trim();
          }
          kimiApiConfig.configured = Boolean(kimiApiConfig.apiKey);
          kimiApiEnabled = recomputeKimiEnabled();
          try {
            persistKimiConfig(kimiConfigFile, kimiApiConfig);
          } catch (err) {
            sendJson(response, 500, {
              error: 'Failed to persist Kimi config: ' + ((err && err.message) || 'unknown'),
            });
            return;
          }
          // Never echo the API key back to the client; only a boolean flag.
          sendJson(response, 200, {
            configured: kimiApiConfig.configured,
            chatEnabled: kimiApiEnabled,
            planEnabled: kimiApiEnabled,
            baseUrl: kimiApiConfig.baseUrl,
            model: kimiApiConfig.model,
            hasKey: Boolean(kimiApiConfig.apiKey),
          });
        });
        return;
      }

      if (request.method === 'GET' && pathname === '/api/kimi/info') {
        sendJson(response, 200, {
          provider: 'kimi-api',
          configured: kimiApiConfig.configured,
          planEnabled: kimiApiEnabled,
          chatEnabled: kimiApiEnabled,
          baseUrl: kimiApiConfig.baseUrl,
          model: kimiApiConfig.model,
          hasKey: Boolean(kimiApiConfig.apiKey),
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/kimi/plan') {
        await withJsonBody(request, response, async (body) => {
          if (!kimiApiEnabled) {
            sendJson(response, 503, {
              error: 'Kimi API is not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY to enable it.',
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
          if (!kimiApiEnabled) {
            sendJson(response, 503, {
              error: 'Kimi API is not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY to enable it.',
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

      if (request.method === 'POST' && pathname === '/api/agent/chat/stream') {
        await withJsonBody(request, response, async (body) => {
          if (!kimiApiEnabled) {
            sendJson(response, 503, { error: 'Kimi API is not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY to enable it.' });
            return;
          }
          if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
            sendJson(response, 400, { error: 'body.prompt is required' });
            return;
          }
          const safeRoot = safeTrustedRoot(body.trustedRoot);
          if (draining) {
            sendJson(response, 503, { error: '服务正在停机，暂不接受新任务。', context: requestContext });
            return;
          }
          const releaseSlot = agentConcurrency.tryAcquire(requestContext.tenantId);
          if (!releaseSlot) {
            sendJson(response, 429, { error: '并发运行数已达上限，请稍后重试。', context: requestContext });
            return;
          }
          try {
            await streamAgentChat({
            response,
            request,
            requestContext,
            body,
            kimiConfig: kimiApiConfig,
            trustedRoot: safeRoot,
            runStoreRoot,
            runsIndex,
            runEvents,
            sandbox: sandboxEnabled ? sandbox : null,
            sandboxLimits,
            modelCall: config.agentModelCall,
            toolRegistry,
            skillRegistry,
            approvals: approvalRegistry,
            cancellation,
            scheduler: activeScheduler,
            });
          } finally {
            releaseSlot();
          }
        });
        return;
      }

      if (request.method === 'POST' && pathname === '/api/kimi/chat/stream') {
        await withJsonBody(request, response, async (body) => {
          if (!kimiApiEnabled) {
            sendJson(response, 503, { error: 'Kimi API is not configured. Set KIMI_API_KEY or MOONSHOT_API_KEY to enable it.' });
            return;
          }
          if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
            sendJson(response, 400, { error: 'body.prompt is required' });
            return;
          }
          const safeRoot = safeTrustedRoot(body.trustedRoot);
          await streamChat({
            response,
            requestContext,
            body,
            streamRunner: kimiChatStreamRunner,
            cancellation,
            kimiConfig: kimiApiConfig,
            trustedRoot: safeRoot,
            runStoreRoot,
            runsIndex,
          });
        });
        return;
      }

      if (await handleWorkspaceFileRoutes({
        request,
        response,
        pathname,
        requestContext,
        trustedRootDefault,
        config,
        cacheKeyFor,
        requireIdempotencyKey,
        sendCachedOrStore,
        safeTrustedRoot,
      })) {
        return;
      }

      if (await handleSandboxRoutes({
        request,
        response,
        pathname,
        requestContext,
        sandbox,
        sandboxEnabled,
        sandboxLimits,
        runStoreRoot,
        runsIndex,
        runEvents,
        cacheKeyFor,
        requireIdempotencyKey,
        sendCachedOrStore,
        safeTrustedRoot,
      })) {
        return;
      }

      if (await handleToolRoutes({
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
      })) {
        return;
      }

      if (await handleVizRoutes({
        request,
        response,
        pathname,
        requestUrl,
        requestContext,
        trustedRootDefault,
        safeTrustedRoot,
        cacheKeyFor,
        requireIdempotencyKey,
        sendCachedOrStore,
      })) {
        return;
      }

      if (await handleSkillRoutes({ request, response, pathname, requestContext, skillRegistry })) {
        return;
      }

      if (await handlePlanRoutes({ request, response, pathname, requestContext, toolRegistry, planner: config.planner })) {
        return;
      }

      if (await handleClarifyRoutes({ request, response, pathname, requestContext, clarifications })) {
        return;
      }

      if (await handleConnectorRoutes({
        request, response, pathname, requestUrl, requestContext,
        toolRegistry, safeTrustedRoot,
        fsServerPath: path.join(hostSrcDir, '../mcp-servers/fs-server.mjs'),
        // Route through server.connectMcpServers (NOT a bare connectMcpServers call)
        // so the spawned MCP clients are registered in server._mcpClients and get
        // reaped by server.closeMcp()/shutdown(). Otherwise connector-API children
        // leak — they keep the process alive (the host never exits cleanly).
        connectMcp: (servers) => server.connectMcpServers(servers),
      })) {
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
      // Never leak internal detail (stack/paths/secrets) to clients. Log it
      // redacted for ops; return a generic 500. Expected validation errors are
      // already handled by the route handlers above with their own safe messages.
      try { console.error('[host] unhandled request error:', redactText(String((err && err.stack) || err))); } catch { /* ignore */ }
      sendJson(response, 500, { error: 'internal server error' });
    }
  });


  server.toolRegistry = toolRegistry;
  server._mcpClients = [];
  server.connectMcpServers = async (servers) => {
    const outcome = await connectMcpServers({ registry: toolRegistry, servers, spawn: config.mcpSpawn });
    server._mcpClients.push(...outcome.clients);
    return outcome;
  };
  server.closeMcp = () => { closeMcpClients(server._mcpClients); server._mcpClients = []; };

  // Graceful shutdown: stop accepting new streams, abort in-flight runs so their
  // SSE connections drain, unblock awaiting approvals, close MCP children, then
  // close the listener (with a hard timeout so a stuck socket can't hang exit).
  server.isDraining = () => draining;
  server.shutdown = async ({ timeoutMs = 10000 } = {}) => {
    draining = true;
    try { cancellation.cancelAll('shutdown'); } catch { /* ignore */ }
    try { approvalRegistry.cancelAll('reject'); } catch { /* ignore */ }
    try { server.closeMcp(); } catch { /* ignore */ }
    // Stop the schedule tick (the interval is unref'd, but stopping it releases
    // its store/handles deterministically — important for clean test teardown).
    try { if (activeScheduler && typeof activeScheduler.stop === 'function') activeScheduler.stop(); } catch { /* ignore */ }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      // Forcibly destroy lingering keep-alive / SSE sockets so server.close()'s
      // callback can actually fire. Without this, an open EventStream socket
      // keeps the event loop alive forever and the process never exits — the
      // root cause of the full-suite test hang / libuv close-race assertion.
      try { if (typeof server.closeAllConnections === 'function') server.closeAllConnections(); } catch { /* ignore */ }
      server.close(() => { clearTimeout(timer); resolve(); });
    });
  };

  if (Array.isArray(config.mcpServers) && config.mcpServers.length > 0 && config.connectMcpOnStart !== false) {
    server.connectMcpServers(config.mcpServers).catch(() => { /* a broken connector must not crash startup */ });
  }

  return server;
}
