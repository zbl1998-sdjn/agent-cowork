// 主机运行时状态装配(host · L2 运行时 · runtime)
// 职责:把 host 运行所需的各类「单例状态/服务」装配到一处——运行索引、调度器、事件总线、会话/记忆存储、
//       沙箱、Kimi API 配置等(文件 or Postgres 后端按配置择一)。供 server.js 在组装根注入路由使用。
// 注:这是 L2 内的「运行时状态聚合」,仍只依赖 L0/L1 与同层;真正的 HTTP 装配在 L4 server.js。
// 依赖:kimi/api-runner、storage/*、memory、sandbox 及同层 runs-index/scheduler/run-events 等。导出:host 状态工厂。
import path from 'node:path';
import { resolveAgentModelConfig, runModelApiChat, runModelApiPlan, runModelApiChatStream } from '../engine/api-runner.js';
import { createRunsIndex } from './runs-index.js';
import { createPostgresRunsIndex, withSafeWrites } from '../storage/postgres-runs-index.js';
import { RunEventBus } from './run-events.js';
import { createMemoryStore } from '../memory/memory-store.js';
import { assertTrustedPathForCreate } from '../security/path-policy.js';
import { createConversationStore } from '../storage/conversation-store.js';
import { createPostgresConversationStore } from '../storage/postgres-conversation-store.js';
import { createSandbox } from '../sandbox/index.js';
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
import { createEnrollmentPolicy } from '../auth/enrollment-policy.js';
import { resolveGlobalMutationAdmins } from '../auth/global-mutation-admin.js';
import { createCredentialStore } from '../security/credential-store.js';
import { getAppHome } from '../storage/app-home.js';
import { sendJson, type HttpResponseLike } from '../http/request-utils.js';
import { omitUndefined } from '../util/object.js';
import { applyPersistedAgentModelConfig, persistModelConfig } from '../engine/config-store.js';
import { providerRuntimeState } from '../engine/provider-profiles.js';
import { createKimiRefineModelCall } from '../engine/prompt/refine-model-call.js';
import { resolveSandboxStartup } from '../sandbox/startup-probe.js';
import { resolveStoreBackendConfig } from './store-backend-config.js';
import {
  defaultStaticRoot,
  defaultUiDistRoot,
  isUiDistEnabled,
} from '../http/static-assets.js';
import { createProjectStoreResolver } from './project-stores.js';
import { configureHostScheduler } from './host-scheduler.js';
import { indexHostRun } from './host-run-indexing.js';
import { idempotencyCacheKey } from './idempotency-key.js';
import { createHostStatePathResolvers } from './host-state-paths.js';
import { resolveHostSandboxLimits } from './host-sandbox-limits.js';
import { createFolderGrantStore } from '../workspace/folder-grant-store.js';
import { createFolderGrantRegistry } from './folder-grants.js';
import { resolveOnlyOfficeConfig } from '../artifacts/onlyoffice-config.js';
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
  // 配置优先级在装配根统一处理:config→环境变量→安全默认值,排查只需看 HostConfig 与 `.env.example`。
  const trustedRootDefault = path.resolve(config.trustedRoot || process.env.TRUSTED_ROOT || process.cwd());
  const staticRoot = config.staticRoot === false ? null : path.resolve(config.staticRoot || defaultStaticRoot(hostSrcDir));
  const uiDistRoot = path.resolve(config.uiDistRoot || defaultUiDistRoot(hostSrcDir));
  const statePaths = createHostStatePathResolvers(config, trustedRootDefault);
  const modelConfigFile = statePaths.modelConfigFile();
  const agentModelConfig = resolveAgentModelConfig(config);
  const modelConfigStoreOptions = omitUndefined({ protector: config.kimiConfigProtector });
  applyPersistedAgentModelConfig(modelConfigFile, agentModelConfig, modelConfigStoreOptions);
  const securityMode = agentModelConfig.securityMode;
  const folderGrantStore = config.folderGrantStore || createFolderGrantStore(omitUndefined({
    filePath: statePaths.folderGrantStoreFile(),
    protector: config.folderGrantProtector,
  }));
  const folderGrants = config.folderGrants || createFolderGrantRegistry({ trustedRootDefault, store: folderGrantStore });
  const state: HostState = {
    config,
    hostSrcDir,
    trustedRootDefault,
    staticRoot,
    uiDistRoot,
    uiDistEnabled: isUiDistEnabled(config, uiDistRoot),
    modelConfigFile,
    securityMode,
    agentModelConfig,
    modelPlanRunner: config.modelPlanRunner || runModelApiPlan,
    modelChatRunner: config.modelChatRunner || runModelApiChat,
    modelChatStreamRunner: config.modelChatStreamRunner || runModelApiChatStream,
    runStoreRoot: config.runStoreRoot ? path.resolve(config.runStoreRoot) : assertTrustedPathForCreate(path.join(trustedRootDefault, '.AgentCowork', 'runs'), trustedRootDefault),
    idempotencyStore: config.idempotencyStore instanceof Map
      ? config.idempotencyStore as Map<string, IdempotencyEntry>
      : new Map<string, IdempotencyEntry>(),
    draining: false,
    startupReady: Promise.resolve(),
    approvalRegistry: config.approvalRegistry as ApprovalRegistryLike,
    authStore: config.authStore as HostState['authStore'],
    enrollmentPolicy: createEnrollmentPolicy(config.enrollmentToken ?? (process.env.ACW_ENROLLMENT_TOKEN || process.env.KCW_ENROLLMENT_TOKEN)),
    cancellation: config.cancellation as CancellationRegistryLike,
    runEvents: config.runEventBus as RunEventsState,
    runsIndex: config.runsIndex as HostState['runsIndex'],
    sandboxStartup: config.sandboxStartup as HostState['sandboxStartup'],
    folderGrantStore, folderGrants,
    onlyOfficeConfig: resolveOnlyOfficeConfig(config.onlyOffice), onlyOfficeFetch: config.onlyOfficeFetch || fetch,
    safeTrustedRoot: folderGrants.safeTrustedRoot,
    toolRegistry: config.toolRegistry as HostState['toolRegistry'],
    globalMutationAdmins: resolveGlobalMutationAdmins(config.globalMutationAdmins, process.env),
    allowLocalModelConfigSelfService: config.allowLocalModelConfigSelfService === true,
  };
  state.recomputeModelEnabled = () => {
    state.modelApiEnabled = config.enableModelApi !== false && (providerRuntimeState(agentModelConfig, agentModelConfig.provider).enabled || Boolean(config.modelPlanRunner) || Boolean(config.modelChatRunner));
    return state.modelApiEnabled;
  };
  state.recomputeModelEnabled();
  state.persistModelConfig = () => persistModelConfig(statePaths.modelConfigFile(), agentModelConfig, modelConfigStoreOptions);
  // 提示词改写(/api/prompt/refine)默认接入当前模型:未显式注入且已配置 API Key 时,
  // 用当前 Kimi 配置造一个 refine 专用的非流式模型调用;否则保持空,refiner 走本地兜底。
  if (!config.promptRefineModelCall && !config.promptRefiner && agentModelConfig.configured) {
    config.promptRefineModelCall = createKimiRefineModelCall({
      modelConfig: agentModelConfig as unknown as Record<string, unknown>, ...(typeof config.fetchImpl === 'function' ? { fetchImpl: config.fetchImpl as typeof fetch } : {}),
    });
    if (config.promptRefineTimeoutMs == null) {
      config.promptRefineTimeoutMs = 20_000;
    }
  }

  const runsIndexRoot = config.runsIndexRoot ? path.resolve(config.runsIndexRoot) : assertTrustedPathForCreate(path.join(trustedRootDefault, '.AgentCowork', 'index'), trustedRootDefault);
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
    requestedBackend: config.sandboxBackend || process.env.ACW_SANDBOX_BACKEND || process.env.KCW_SANDBOX_BACKEND || 'auto',
    sandboxOptions: config.sandboxOptions || {},
    securityMode,
    env: process.env,
    spawnSync: config.sandboxProbeSpawnSync,
    timeoutMs: config.sandboxProbeTimeoutMs,
  }));
  state.sandbox = config.sandbox || createSandbox(state.sandboxStartup.options);
  state.sandboxLimits = resolveHostSandboxLimits(config);
  // 严格本地模式(local_demo/local_strict/air_gap)下若没有真隔离的沙箱后端(Docker/VM/
  // Hyper-V),policyBlocked=true——此前这个字段只写进 info 供展示,从未被读取来真正
  // 阻止 sandbox.exec/sandbox.run-code 注册,等于「宣称阻塞高风险工具」但代码里从没
  // 阻塞过(dogfood 实测发现)。这里真正据此决定要不要把 sandbox 传给工具装配。
  const sandboxPolicyBlocked = state.sandboxStartup.info?.policyBlocked === true;
  state.toolRegistry = (config.toolRegistry || createToolRegistry().registerMany(createBuiltinTools({
    sandbox: state.sandboxEnabled && !sandboxPolicyBlocked ? state.sandbox : null,
    sandboxLimits: state.sandboxLimits,
    runStoreRoot: state.runStoreRoot,
    runEvents: state.runEvents,
    runsIndex: state.runsIndex,
    // 传 getter 而非快照值:agentModelConfig 会被 agent-engine-routes 等原地更新,WebFetch/WebSearch
    // 的出站策略检查必须读到「当前」安全模式,不是装配这一刻的值。
    resolveSecurityMode: () => agentModelConfig.securityMode,
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
    const startupTasks: Array<Promise<unknown>> = [];
    if (state.approvalRegistry?.start) startupTasks.push(Promise.resolve(state.approvalRegistry.start()));
    if (state.runEvents?.start) startupTasks.push(Promise.resolve(state.runEvents.start()));
    state.startupReady = Promise.all(startupTasks).then(() => undefined);
  }
  state.agentConcurrency = config.agentConcurrency || createConcurrencyLimiter({
    maxConcurrent: Number(process.env.ACW_MAX_CONCURRENT_RUNS || process.env.KCW_MAX_CONCURRENT_RUNS || 64),
    maxPerTenant: Number(process.env.ACW_MAX_RUNS_PER_TENANT || process.env.KCW_MAX_RUNS_PER_TENANT || 8),
  });
  state.rateLimiter = config.rateLimit === false ? null : (config.rateLimiter || createRateLimiter({
    ratePerSec: Number(config.rateLimitPerSec || process.env.ACW_RATE_PER_SEC || process.env.KCW_RATE_PER_SEC || 50),
    burst: Number(config.rateLimitBurst || process.env.ACW_RATE_BURST || process.env.KCW_RATE_BURST || 100),
  }));
  state.clarifications = config.clarifications || createClarificationStore();
  state.authStore = config.authStore || ((config.persistAuth ?? ((process.env.ACW_AUTH_PERSIST ?? process.env.KCW_AUTH_PERSIST) !== 'false'))
    ? createSqliteUserStore({ dbPath: statePaths.authDbPath() })
    : createUserStore());
  // 凭证仓库是 OAuth/API token 的唯一持久入口;前端只拿脱敏状态,不接触明文凭证。
  state.credentialStore = config.credentialStore || createCredentialStore({
    filePath: path.resolve(config.credentialStorePath || process.env.ACW_CREDENTIAL_STORE || process.env.KCW_CREDENTIAL_STORE || path.join(getAppHome(), 'credentials.json')),
  });
  state.oauthSessions = config.oauthSessions || new Map();
  state.oauthFetch = config.oauthFetch || fetch;
  state.oauthConfig = config.oauthConfig || {};
  state.jwtSecret = config.jwtSecret || process.env.ACW_JWT_SECRET || process.env.KCW_JWT_SECRET || null;
  state.requireAuth = config.requireAuth ?? ((process.env.ACW_REQUIRE_AUTH ?? process.env.KCW_REQUIRE_AUTH) !== 'false');
  state.trustIdentityHeaders = config.trustIdentityHeaders ?? ((process.env.ACW_TRUST_IDENTITY_HEADERS ?? process.env.KCW_TRUST_IDENTITY_HEADERS) === 'true');
  // Host 头白名单用于抵御 DNS rebinding,默认开启;只有明确绑定非回环地址时才关闭。
  state.validateHost = config.validateHost ?? ((process.env.ACW_VALIDATE_HOST ?? process.env.KCW_VALIDATE_HOST) !== 'false');

  // 状态对象保留原接口；索引归一化与失败隔离由同层 helper 负责。
  state.indexRun = (
    record: Record<string, unknown>,
    context?: Record<string, unknown>,
  ): void => indexHostRun(state.runsIndex, record, context);
  state.cacheKeyFor = idempotencyCacheKey;
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
