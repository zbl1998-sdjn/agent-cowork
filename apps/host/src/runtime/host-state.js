import path from 'node:path';
import { resolveKimiApiConfig, runKimiApiChat, runKimiApiPlan, runKimiApiChatStream } from '../kimi/api-runner.js';
import { createRunsIndex, summariseRunForIndex } from './runs-index.js';
import { createPostgresRunsIndex, withSafeWrites } from '../storage/postgres-runs-index.js';
import { Scheduler, createScheduleStore } from './scheduler.js';
import { RunEventBus } from './run-events.js';
import { runRecipe } from '../recipes/run-recipe.js';
import { createMemoryStore } from '../memory/memory-store.js';
import { assertTrustedPath } from '../security/path-policy.js';
import { createConversationStore } from '../storage/conversation-store.js';
import { createPostgresConversationStore } from '../storage/postgres-conversation-store.js';
import { createSandbox, DEFAULT_ALLOW_TOOLS } from '../sandbox/index.js';
import { createToolRegistry } from '../tools/tool-registry.js';
import { createBuiltinTools } from '../tools/builtin-tools.js';
import { createSkillRegistry } from '../skills/skill-registry.js';
import { createCancellationRegistry } from './cancellation.js';
import { createPostgresApprovalStore } from '../storage/postgres-approvals.js';
import { createPostgresEventBus } from '../storage/postgres-event-bus.js';
import { createPostgresMemoryStore } from '../storage/postgres-memory-store.js';
import { createCachedPostgresScheduleStore } from '../storage/cached-pg-schedule-store.js';
import { createConcurrencyLimiter } from './concurrency.js';
import { createRateLimiter } from './rate-limit.js';
import { createApprovalRegistry } from './approvals.js';
import { createFileOperationApprovalStore } from './file-operation-approvals.js';
import { createOAuthPermissionApprovalStore } from './oauth-permission-approvals.js';
import { createClarificationStore } from './clarifications.js';
import { createUserStore } from '../auth/user-store.js';
import { createSqliteUserStore } from '../auth/sqlite-user-store.js';
import { createCredentialStore } from '../security/credential-store.js';
import { getAppHome } from '../storage/app-home.js';
import { sendJson } from '../http/request-utils.js';
import { applyPersistedKimiConfig, persistKimiConfig } from '../kimi/config-store.js';
import { resolveSandboxStartup } from '../sandbox/startup-probe.js';
import {
  defaultStaticRoot,
  defaultUiDistRoot,
  isUiDistEnabled,
} from '../http/static-assets.js';
import { createProjectStoreResolver } from './project-stores.js';

// @ts-check

/**
 * @typedef {{ [key: string]: any }} HostConfig
 * @typedef {{ tenantId?: string, userId?: string, traceId?: string, idempotencyKey?: string }} RequestContextLike
 * @typedef {{ id: string, tenantId?: string, userId?: string, traceId?: string | null, payload?: unknown }} ScheduleRecordLike
 * @typedef {{ [key: string]: any, config: HostConfig, hostSrcDir: string, trustedRootDefault: string, staticRoot: string | null, uiDistRoot: string, uiDistEnabled: boolean, kimiConfigFile: string, kimiApiConfig: any, runStoreRoot: string, idempotencyStore: Map<string, any>, draining: boolean }} HostState
 */

/** @param {HostConfig} config @param {{ hostSrcDir: string }} options @returns {HostState} */
export function createHostState(config = {}, { hostSrcDir }) {
  const trustedRootDefault = path.resolve(config.trustedRoot || process.env.TRUSTED_ROOT || process.cwd());
  const staticRoot = config.staticRoot === false
    ? null
    : path.resolve(config.staticRoot || defaultStaticRoot(hostSrcDir));
  const uiDistRoot = path.resolve(config.uiDistRoot || defaultUiDistRoot(hostSrcDir));
  const kimiConfigFile = path.resolve(
    config.kimiConfigFile || path.join(trustedRootDefault, '.AgentCowork', 'config.json'),
  );
  const kimiApiConfig = resolveKimiApiConfig(config);
  applyPersistedKimiConfig(kimiConfigFile, kimiApiConfig);

  /** @type {HostState} */
  const state = {
    config,
    hostSrcDir,
    trustedRootDefault,
    staticRoot,
    uiDistRoot,
    uiDistEnabled: isUiDistEnabled(config, uiDistRoot),
    kimiConfigFile,
    kimiApiConfig,
    kimiPlanRunner: config.kimiPlanRunner || runKimiApiPlan,
    kimiChatRunner: config.kimiChatRunner || runKimiApiChat,
    kimiChatStreamRunner: config.kimiChatStreamRunner || runKimiApiChatStream,
    runStoreRoot: path.resolve(config.runStoreRoot || path.join(trustedRootDefault, '.AgentCowork', 'runs')),
    idempotencyStore: config.idempotencyStore || new Map(),
    draining: false,
  };

  state.recomputeKimiEnabled = () => {
    state.kimiApiEnabled = config.enableKimiApi !== false
      && (kimiApiConfig.configured || Boolean(config.kimiPlanRunner) || Boolean(config.kimiChatRunner));
    return state.kimiApiEnabled;
  };
  state.recomputeKimiEnabled();
  state.persistKimiConfig = () => persistKimiConfig(kimiConfigFile, kimiApiConfig);

  const runsIndexRoot = path.resolve(config.runsIndexRoot || path.join(trustedRootDefault, '.AgentCowork', 'index'));
  const storeRaw = String(config.storeBackend || process.env.KCW_STORE || 'file').toLowerCase();
  state.storeBackend = storeRaw === 'sqlite' ? 'sqlite' : storeRaw === 'postgres' ? 'postgres' : 'file';
  state.databaseUrl = config.databaseUrl || process.env.DATABASE_URL || null;
  state.usePostgresState = state.storeBackend === 'postgres' && !!state.databaseUrl;
  state.sqliteDbPath = path.resolve(
    config.sqliteDbPath || process.env.KCW_SQLITE_PATH || path.join(trustedRootDefault, '.AgentCowork', 'state.sqlite'),
  );
  state.runsIndex = config.runsIndex || (state.storeBackend === 'postgres'
    ? withSafeWrites(createPostgresRunsIndex({ connectionString: state.databaseUrl }))
    : createRunsIndex({ backend: state.storeBackend, indexRoot: runsIndexRoot, dbPath: state.sqliteDbPath }));
  state.memoryStore = config.memoryStore || (state.usePostgresState
    ? createPostgresMemoryStore({ connectionString: state.databaseUrl })
    : createMemoryStore({ backend: state.storeBackend, dbPath: state.sqliteDbPath }));
  state.conversationStore = config.conversationStore || (state.usePostgresState
    ? createPostgresConversationStore({ connectionString: state.databaseUrl })
    : createConversationStore({ backend: state.storeBackend }));
  Object.assign(state, createProjectStoreResolver(config));
  state.runEvents = config.runEventBus || (state.usePostgresState
    ? createPostgresEventBus({ connectionString: state.databaseUrl })
    : new RunEventBus());

  state.sandboxEnabled = config.enableSandbox !== false;
  state.sandboxStartup = config.sandboxStartup || resolveSandboxStartup({
    requestedBackend: config.sandboxBackend || process.env.KCW_SANDBOX_BACKEND || 'auto',
    sandboxOptions: config.sandboxOptions || {},
    env: process.env,
    spawnSync: config.sandboxProbeSpawnSync,
    timeoutMs: config.sandboxProbeTimeoutMs,
  });
  state.sandbox = config.sandbox || createSandbox(state.sandboxStartup.options);
  state.sandboxLimits = {
    allowTools: config.sandboxAllowTools || DEFAULT_ALLOW_TOOLS,
    allowEnv: config.sandboxAllowEnv || [],
    maxTimeoutMs: config.sandboxMaxTimeoutMs,
    defaultMaxOutputBytes: config.sandboxMaxOutputBytes,
  };
  state.toolRegistry = config.toolRegistry || createToolRegistry().registerMany(createBuiltinTools({
    sandbox: state.sandboxEnabled ? state.sandbox : null,
    sandboxLimits: state.sandboxLimits,
    runStoreRoot: state.runStoreRoot,
    runEvents: state.runEvents,
    runsIndex: state.runsIndex,
  }));
  state.skillRegistry = config.skillRegistry || createSkillRegistry();
  state.cancellation = config.cancellation || createCancellationRegistry();
  state.approvalRegistry = config.approvalRegistry || (state.usePostgresState
    ? createPostgresApprovalStore({ connectionString: state.databaseUrl })
    : createApprovalRegistry());
  state.fileOperationApprovals = config.fileOperationApprovals || createFileOperationApprovalStore({
    ttlMs: config.fileOperationApprovalTtlMs,
  });
  state.oauthPermissionApprovals = config.oauthPermissionApprovals || createOAuthPermissionApprovalStore({
    ttlMs: config.oauthPermissionApprovalTtlMs,
  });
  if (state.usePostgresState) {
    if (state.approvalRegistry?.start) Promise.resolve(state.approvalRegistry.start()).catch(() => {});
    if (state.runEvents?.start) Promise.resolve(state.runEvents.start()).catch(() => {});
  }
  state.agentConcurrency = config.agentConcurrency || createConcurrencyLimiter({
    maxConcurrent: Number(process.env.KCW_MAX_CONCURRENT_RUNS || 64),
    maxPerTenant: Number(process.env.KCW_MAX_RUNS_PER_TENANT || 8),
  });
  state.rateLimiter = config.rateLimit === false ? null : (config.rateLimiter || createRateLimiter({
    ratePerSec: Number(config.rateLimitPerSec || process.env.KCW_RATE_PER_SEC || 50),
    burst: Number(config.rateLimitBurst || process.env.KCW_RATE_BURST || 100),
  }));
  state.clarifications = config.clarifications || createClarificationStore();
  state.authStore = config.authStore || ((config.persistAuth ?? (process.env.KCW_AUTH_PERSIST !== 'false'))
    ? createSqliteUserStore({ dbPath: path.resolve(config.authDbPath || process.env.KCW_AUTH_DB || path.join(trustedRootDefault, '.AgentCowork', 'auth.sqlite')) })
    : createUserStore());
  state.credentialStore = config.credentialStore || createCredentialStore({
    filePath: path.resolve(config.credentialStorePath || process.env.KCW_CREDENTIAL_STORE || path.join(getAppHome(), 'credentials.json')),
  });
  state.oauthSessions = config.oauthSessions || new Map();
  state.oauthFetch = config.oauthFetch || fetch;
  state.oauthConfig = config.oauthConfig || {};
  state.jwtSecret = config.jwtSecret || process.env.KCW_JWT_SECRET || null;
  state.requireAuth = config.requireAuth ?? (process.env.KCW_REQUIRE_AUTH !== 'false');
  state.trustIdentityHeaders = config.trustIdentityHeaders ?? (process.env.KCW_TRUST_IDENTITY_HEADERS === 'true');

  state.safeTrustedRoot = (requestedRoot = trustedRootDefault) => (
    assertTrustedPath(path.resolve(requestedRoot || trustedRootDefault), trustedRootDefault)
  );
  /** @param {Record<string, any>} record @param {Record<string, unknown>} [ctx] */
  state.indexRun = (record, ctx) => {
    try {
      const context = ctx || record.context || {};
      state.runsIndex.upsert(summariseRunForIndex({ ...record, runPath: record.runPath }, context), context);
    } catch {
      // index failures must never break the request path
    }
  };
  /** @param {RequestContextLike} context @param {string} method @param {string} pathname */
  state.cacheKeyFor = (context, method, pathname) => (
    context.idempotencyKey ? `${context.tenantId}:${context.userId}:${method}:${pathname}:${context.idempotencyKey}` : ''
  );
  /** @param {any} response @param {RequestContextLike} context */
  state.requireIdempotencyKey = (response, context) => {
    if (context.idempotencyKey) return true;
    sendJson(response, 428, { error: 'Idempotency-Key header is required for this write operation' });
    return false;
  };
  /** @param {any} response @param {string} cacheKey @param {string | undefined} fingerprint @param {number} status @param {any} payload */
  state.sendCachedOrStore = (response, cacheKey, fingerprint, status, payload) => {
    if (cacheKey && state.idempotencyStore.has(cacheKey)) {
      const cached = state.idempotencyStore.get(cacheKey);
      if (fingerprint && cached.fingerprint && cached.fingerprint !== fingerprint) {
        sendJson(response, 409, { error: 'Idempotency-Key reused with different request body' });
        return true;
      }
      sendJson(response, cached.status, { ...cached.payload, idempotentReplay: true });
      return true;
    }
    if (payload === undefined) return false;
    if (cacheKey) state.idempotencyStore.set(cacheKey, { status, payload, fingerprint });
    sendJson(response, status, payload);
    return false;
  };

  state.activeScheduler = config.scheduler || null;
  if (!state.activeScheduler && config.enableScheduler !== false) {
    /** @param {ScheduleRecordLike} record */
    const defaultScheduleExecutor = async (record) => {
      const payload = record.payload && typeof record.payload === 'object'
        ? /** @type {Record<string, any>} */ (record.payload)
        : {};
      if (!payload.recipeId) return { runId: null, note: `scheduler-noop:${record.id}` };
      const result = runRecipe({
        recipeId: payload.recipeId,
        trustedRoot: state.safeTrustedRoot(payload.trustedRoot || trustedRootDefault),
        prompt: payload.prompt || '',
        files: payload.files || [],
        maxSize: payload.maxSize,
        context: { tenantId: record.tenantId, userId: record.userId, traceId: record.traceId || '' },
        runStoreRoot: state.runStoreRoot,
        runEvents: state.runEvents,
        runsIndex: state.runsIndex,
      });
      return { runId: result.runId, operations: result.operations.length };
    };
    const executor = config.scheduleExecutor || defaultScheduleExecutor;
    state.activeScheduler = new Scheduler({
      storeDir: path.resolve(config.scheduleStoreDir || path.join(trustedRootDefault, '.AgentCowork', 'schedules')),
      store: config.scheduleStore || (state.usePostgresState
        ? createCachedPostgresScheduleStore({ connectionString: state.databaseUrl })
        : createScheduleStore({ backend: state.storeBackend, storeDir: path.resolve(config.scheduleStoreDir || path.join(trustedRootDefault, '.AgentCowork', 'schedules')), dbPath: state.sqliteDbPath })),
      executor,
      tickIntervalMs: config.schedulerTickMs || 30_000,
    });
    if (config.startScheduler !== false) state.activeScheduler.start();
  }

  return state;
}
