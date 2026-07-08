// 主机运行时状态装配(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:把 host 运行所需的各类「单例状态/服务」装配到一处——运行索引、调度器、事件总线、会话/记忆存储、
//       沙箱、Kimi API 配置等(文件 or Postgres 后端按配置择一)。供 server.js 在组装根注入路由使用。
// 注:这是 L2 内的「运行时状态聚合」,仍只依赖 L0/L1 与同层;真正的 HTTP 装配在 L4 server.js。
// 依赖:kimi/api-runner、storage/*、memory、sandbox 及同层 runs-index/scheduler/run-events 等。导出:host 状态工厂。
import path from 'node:path';
import { resolveKimiApiConfig, runKimiApiChat, runKimiApiPlan, runKimiApiChatStream } from '../kimi/api-runner.js';
import { createRunsIndex, summariseRunForIndex } from './runs-index.js';
import { createPostgresRunsIndex, withSafeWrites } from '../storage/postgres-runs-index.js';
import { RunEventBus } from './run-events.js';
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
import { sendJson, type HttpResponseLike } from '../http/request-utils.js';
import { omitUndefined } from '../util/object.js';
import { applyPersistedKimiConfig, persistKimiConfig } from '../kimi/config-store.js';
import { createKimiRefineModelCall } from '../kimi/prompt/refine-model-call.js';
import { resolveSandboxStartup } from '../sandbox/startup-probe.js';
import { resolveStoreBackendConfig } from './store-backend-config.js';
import {
  defaultStaticRoot,
  defaultUiDistRoot,
  isUiDistEnabled,
} from '../http/static-assets.js';
import { createProjectStoreResolver } from './project-stores.js';
import { configureHostScheduler } from './host-scheduler.js';
import type {
  ApprovalRegistryLike,
  CancellationRegistryLike,
  HostConfig,
  HostState,
  IdempotencyEntry,
  RequestContextLike,
  RunEventsState,
} from './host-state-types.js';

export function createHostState(config: HostConfig = {}, { hostSrcDir }: { hostSrcDir: string }): HostState {
  // 配置优先级统一在装配根处理:测试/嵌入式调用传入 config,本地运行再读环境变量,最后落到安全默认值。
  // 这样面试或部署排查时只需从 HostConfig + `.env.example` 两个入口追配置来源。
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
  const securityMode = kimiApiConfig.securityMode;

  const state: HostState = {
    config,
    hostSrcDir,
    trustedRootDefault,
    staticRoot,
    uiDistRoot,
    uiDistEnabled: isUiDistEnabled(config, uiDistRoot),
    kimiConfigFile,
    securityMode,
    kimiApiConfig,
    kimiPlanRunner: config.kimiPlanRunner || runKimiApiPlan,
    kimiChatRunner: config.kimiChatRunner || runKimiApiChat,
    kimiChatStreamRunner: config.kimiChatStreamRunner || runKimiApiChatStream,
    runStoreRoot: path.resolve(config.runStoreRoot || path.join(trustedRootDefault, '.AgentCowork', 'runs')),
    idempotencyStore: config.idempotencyStore instanceof Map
      ? config.idempotencyStore as Map<string, IdempotencyEntry>
      : new Map<string, IdempotencyEntry>(),
    draining: false,
    approvalRegistry: config.approvalRegistry as ApprovalRegistryLike,
    authStore: config.authStore as HostState['authStore'],
    cancellation: config.cancellation as CancellationRegistryLike,
    runEvents: config.runEventBus as RunEventsState,
    runsIndex: config.runsIndex as HostState['runsIndex'],
    sandboxStartup: config.sandboxStartup as HostState['sandboxStartup'],
    safeTrustedRoot: (requestedRoot: unknown = trustedRootDefault) => (
      assertTrustedPath(path.resolve(String(requestedRoot || trustedRootDefault)), trustedRootDefault)
    ),
    toolRegistry: config.toolRegistry as HostState['toolRegistry'],
  };

  state.recomputeKimiEnabled = () => {
    state.kimiApiEnabled = config.enableKimiApi !== false
      && (kimiApiConfig.configured || Boolean(config.kimiPlanRunner) || Boolean(config.kimiChatRunner));
    return state.kimiApiEnabled;
  };
  state.recomputeKimiEnabled();
  state.persistKimiConfig = () => persistKimiConfig(kimiConfigFile, kimiApiConfig);

  // 提示词改写(/api/prompt/refine)默认接入当前模型:未显式注入且已配置 API Key 时,
  // 用当前 Kimi 配置造一个 refine 专用的非流式模型调用;否则保持空,refiner 走本地兜底。
  if (!config.promptRefineModelCall && !config.promptRefiner && kimiApiConfig.configured) {
    config.promptRefineModelCall = createKimiRefineModelCall({
      kimiConfig: kimiApiConfig as unknown as Record<string, unknown>,
    });
    if (config.promptRefineTimeoutMs == null) {
      config.promptRefineTimeoutMs = 20_000;
    }
  }

  const runsIndexRoot = path.resolve(config.runsIndexRoot || path.join(trustedRootDefault, '.AgentCowork', 'index'));
  // 存储后端在此分流:file/sqlite 适合单机演示,postgres 才启用跨实例 approvals/run-events/memory。
  Object.assign(state, resolveStoreBackendConfig(config, trustedRootDefault));
  state.runsIndex = config.runsIndex || (state.storeBackend === 'postgres'
    ? withSafeWrites(createPostgresRunsIndex(omitUndefined({ connectionString: state.databaseUrl })))
    : createRunsIndex(omitUndefined({ backend: state.storeBackend, indexRoot: runsIndexRoot, dbPath: state.sqliteDbPath })));
  state.memoryStore = config.memoryStore || (state.usePostgresState
    ? createPostgresMemoryStore(omitUndefined({ connectionString: state.databaseUrl }))
    : createMemoryStore(omitUndefined({ backend: state.storeBackend, dbPath: state.sqliteDbPath })));
  state.conversationStore = config.conversationStore || (state.usePostgresState
    ? createPostgresConversationStore(omitUndefined({ connectionString: state.databaseUrl }))
    : createConversationStore(omitUndefined({ backend: state.storeBackend })));
  Object.assign(state, createProjectStoreResolver(config));
  state.runEvents = (config.runEventBus || (state.usePostgresState
    ? createPostgresEventBus(omitUndefined({ connectionString: state.databaseUrl }))
    : new RunEventBus())) as RunEventsState;

  state.sandboxEnabled = config.enableSandbox !== false;
  // 沙箱启动必须“诚实”:Docker 镜像可用才声明网络隔离,否则回退 local 并暴露 networkIsolated=false。
  state.sandboxStartup = config.sandboxStartup || resolveSandboxStartup(omitUndefined({
    requestedBackend: config.sandboxBackend || process.env.KCW_SANDBOX_BACKEND || 'auto',
    sandboxOptions: config.sandboxOptions || {},
    securityMode,
    env: process.env,
    spawnSync: config.sandboxProbeSpawnSync,
    timeoutMs: config.sandboxProbeTimeoutMs,
  }));
  state.sandbox = config.sandbox || createSandbox(state.sandboxStartup.options);
  state.sandboxLimits = omitUndefined({
    allowTools: config.sandboxAllowTools || [...DEFAULT_ALLOW_TOOLS],
    allowEnv: config.sandboxAllowEnv || [],
    maxTimeoutMs: config.sandboxMaxTimeoutMs,
    defaultMaxOutputBytes: config.sandboxMaxOutputBytes,
  });
  state.toolRegistry = (config.toolRegistry || createToolRegistry().registerMany(createBuiltinTools({
    sandbox: state.sandboxEnabled ? state.sandbox : null,
    sandboxLimits: state.sandboxLimits,
    runStoreRoot: state.runStoreRoot,
    runEvents: state.runEvents,
    runsIndex: state.runsIndex,
    // 传 getter 而非快照值:kimiApiConfig 会被 kimi-routes 等原地更新,WebFetch/WebSearch
    // 的出站策略检查必须读到「当前」安全模式,不是装配这一刻的值。
    resolveSecurityMode: () => kimiApiConfig.securityMode,
  }))) as unknown as HostState['toolRegistry'];
  state.skillRegistry = config.skillRegistry || createSkillRegistry();
  state.cancellation = config.cancellation || createCancellationRegistry();
  state.approvalRegistry = (config.approvalRegistry || (state.usePostgresState
    ? createPostgresApprovalStore(omitUndefined({ connectionString: state.databaseUrl }))
    : createApprovalRegistry())) as ApprovalRegistryLike;
  state.fileOperationApprovals = config.fileOperationApprovals || createFileOperationApprovalStore(omitUndefined({
    ttlMs: config.fileOperationApprovalTtlMs,
  }));
  state.oauthPermissionApprovals = config.oauthPermissionApprovals || createOAuthPermissionApprovalStore(omitUndefined({
    ttlMs: config.oauthPermissionApprovalTtlMs,
  }));
  if (state.usePostgresState) {
    if (state.approvalRegistry?.start) Promise.resolve(state.approvalRegistry.start()).catch(() => undefined);
    if (state.runEvents?.start) Promise.resolve(state.runEvents.start()).catch(() => undefined);
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
  // 凭证仓库是 OAuth/API token 的唯一持久入口;前端只拿脱敏状态,不接触明文凭证。
  state.credentialStore = config.credentialStore || createCredentialStore({
    filePath: path.resolve(config.credentialStorePath || process.env.KCW_CREDENTIAL_STORE || path.join(getAppHome(), 'credentials.json')),
  });
  state.oauthSessions = config.oauthSessions || new Map();
  state.oauthFetch = config.oauthFetch || fetch;
  state.oauthConfig = config.oauthConfig || {};
  state.jwtSecret = config.jwtSecret || process.env.KCW_JWT_SECRET || null;
  state.requireAuth = config.requireAuth ?? (process.env.KCW_REQUIRE_AUTH !== 'false');
  state.trustIdentityHeaders = config.trustIdentityHeaders ?? (process.env.KCW_TRUST_IDENTITY_HEADERS === 'true');
  // Host 头白名单用于抵御 DNS rebinding,默认开启;只有明确绑定非回环地址时才关闭。
  state.validateHost = config.validateHost ?? (process.env.KCW_VALIDATE_HOST !== 'false');

  state.safeTrustedRoot = (requestedRoot: unknown = trustedRootDefault) => (
    assertTrustedPath(path.resolve(String(requestedRoot || trustedRootDefault)), trustedRootDefault)
  );
  state.indexRun = (record: Record<string, unknown>, ctx?: Record<string, unknown>): void => {
    try {
      const rawContext = record.context;
      const context = ctx || (rawContext && typeof rawContext === 'object' ? rawContext as Record<string, unknown> : {});
      state.runsIndex.upsert(summariseRunForIndex({ ...record, runPath: record.runPath }, context), context);
    } catch {
      // 索引失败不应打断请求主路径。
    }
  };
  state.cacheKeyFor = (context: RequestContextLike, method: string, pathname: string): string => (
    context.idempotencyKey ? `${context.tenantId}:${context.userId}:${method}:${pathname}:${context.idempotencyKey}` : ''
  );
  state.requireIdempotencyKey = (response: HttpResponseLike, context: RequestContextLike): boolean => {
    if (context.idempotencyKey) return true;
    sendJson(response, 428, { error: 'Idempotency-Key header is required for this write operation' });
    return false;
  };
  state.sendCachedOrStore = (
    response: HttpResponseLike,
    cacheKey: string,
    fingerprint: string | undefined,
    status: number,
    payload: unknown,
  ): boolean => {
    if (cacheKey && state.idempotencyStore.has(cacheKey)) {
      const cached = state.idempotencyStore.get(cacheKey);
      if (fingerprint && cached?.fingerprint && cached.fingerprint !== fingerprint) {
        sendJson(response, 409, { error: 'Idempotency-Key reused with different request body' });
        return true;
      }
      const cachedPayload = cached?.payload && typeof cached.payload === 'object'
        ? cached.payload as Record<string, unknown>
        : { value: cached?.payload };
      sendJson(response, cached?.status || 200, { ...cachedPayload, idempotentReplay: true });
      return true;
    }
    if (payload === undefined) return false;
    if (cacheKey) state.idempotencyStore.set(cacheKey, omitUndefined({ status, payload, fingerprint }));
    sendJson(response, status, payload);
    return false;
  };

  configureHostScheduler({ config, state, trustedRootDefault });

  return state;
}
