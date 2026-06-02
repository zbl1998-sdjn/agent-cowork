// Host 状态装配类型(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:集中描述 createHostState 的配置与状态端口,避免 host-state.ts 为类型声明继续膨胀。
import type { HttpResponseLike } from '../http/request-utils.js';
import type { RateLimiterLike } from '../http/middleware/common.js';
import type { runKimiApiChat, runKimiApiChatStream, runKimiApiPlan } from '../kimi/api-runner.js';
import type { KimiApiConfig } from '../kimi/api-runner-config.js';
import type { McpRegistry } from '../mcp/connect.js';
import type { RunsIndexLike as RecipeRunsIndexLike } from '../recipes/run-recipe-types.js';
import type { SandboxLimits } from '../sandbox/sandbox-spec.js';
import type { SandboxStartupOptions, SandboxStartupResult, SpawnSyncLike } from '../sandbox/startup-probe.js';
import type { ProjectStore, ProjectStoreContext } from './project-stores.js';
import type { ScheduleStore, Scheduler, SchedulerExecutor } from './scheduler.js';
import type { StoreBackend, StoreBackendConfigInput } from './store-backend-config.js';

export type IdempotencyEntry = { status: number; payload: unknown; fingerprint?: string };
export type Startable = { start?: () => unknown | Promise<unknown> };
export type RunEventsState = Startable & { publish?: (...args: unknown[]) => unknown };
export type ApprovalRegistryLike = Startable & { cancelAll?: (decision?: unknown) => void };
export type CancellationRegistryLike = { cancelAll(reason?: unknown): void };
export type AuthStoreLike = {
  resolveToken(token: string): { userId?: string | null; tenantId?: string | null } | null;
};

export type HostConfig = Record<string, unknown> & StoreBackendConfigInput & {
  trustedRoot?: string;
  staticRoot?: string | false;
  uiDistRoot?: string;
  kimiConfigFile?: string;
  kimiPlanRunner?: typeof runKimiApiPlan;
  kimiChatRunner?: typeof runKimiApiChat;
  kimiChatStreamRunner?: typeof runKimiApiChatStream;
  runStoreRoot?: string;
  idempotencyStore?: Map<string, IdempotencyEntry>;
  enableKimiApi?: boolean;
  runsIndexRoot?: string;
  runsIndex?: RecipeRunsIndexLike;
  memoryStore?: unknown;
  conversationStore?: unknown;
  runEventBus?: RunEventsState;
  enableSandbox?: boolean;
  sandboxBackend?: string;
  sandboxOptions?: SandboxStartupOptions;
  sandboxProbeSpawnSync?: SpawnSyncLike;
  sandboxProbeTimeoutMs?: number;
  sandboxStartup?: SandboxStartupResult;
  sandbox?: unknown;
  sandboxAllowTools?: string[];
  sandboxAllowEnv?: string[];
  sandboxMaxTimeoutMs?: number;
  sandboxMaxOutputBytes?: number;
  toolRegistry?: McpRegistry;
  skillRegistry?: unknown;
  cancellation?: CancellationRegistryLike;
  approvalRegistry?: ApprovalRegistryLike;
  fileOperationApprovals?: unknown;
  fileOperationApprovalTtlMs?: number;
  oauthPermissionApprovals?: unknown;
  oauthPermissionApprovalTtlMs?: number;
  agentConcurrency?: unknown;
  rateLimit?: boolean;
  rateLimiter?: RateLimiterLike | null;
  rateLimitPerSec?: string | number;
  rateLimitBurst?: string | number;
  clarifications?: unknown;
  authStore?: AuthStoreLike;
  persistAuth?: boolean;
  authDbPath?: string;
  credentialStore?: unknown;
  credentialStorePath?: string;
  oauthSessions?: unknown;
  oauthFetch?: typeof fetch;
  oauthConfig?: unknown;
  jwtSecret?: string | null;
  requireAuth?: boolean;
  trustIdentityHeaders?: boolean;
  validateHost?: boolean;
  uiDist?: boolean;
  projectStores?: Map<string, ProjectStore>;
  getProjectStore?: (trustedRoot: string, context?: ProjectStoreContext) => ProjectStore;
  scheduler?: Scheduler | null;
  enableScheduler?: boolean;
  scheduleStoreDir?: string;
  scheduleExecutor?: SchedulerExecutor;
  scheduleStore?: ScheduleStore | null;
  schedulerTickMs?: number;
  startScheduler?: boolean;
};

export type RequestContextLike = {
  tenantId?: string;
  userId?: string;
  traceId?: string;
  idempotencyKey?: string;
};

export type HostState = Record<string, unknown> & {
  config: HostConfig;
  hostSrcDir: string;
  trustedRootDefault: string;
  staticRoot: string | null;
  uiDistRoot: string;
  uiDistEnabled: boolean;
  kimiConfigFile: string;
  kimiApiConfig: KimiApiConfig;
  kimiApiEnabled?: boolean;
  runStoreRoot: string;
  idempotencyStore: Map<string, IdempotencyEntry>;
  draining: boolean;
  databaseUrl?: string | null;
  storeBackend?: StoreBackend;
  sqliteDbPath?: string;
  usePostgresState?: boolean;
  runsIndex: RecipeRunsIndexLike;
  approvalRegistry: ApprovalRegistryLike;
  runEvents: RunEventsState;
  activeScheduler?: Scheduler | null;
  authStore: AuthStoreLike;
  cancellation: CancellationRegistryLike;
  jwtSecret?: string | null;
  rateLimiter?: RateLimiterLike | null;
  requireAuth?: boolean;
  sandbox?: unknown;
  sandboxEnabled?: boolean;
  sandboxLimits?: SandboxLimits;
  sandboxStartup: SandboxStartupResult;
  toolRegistry: McpRegistry;
  trustIdentityHeaders?: boolean;
  validateHost?: boolean;
  recomputeKimiEnabled?: () => boolean;
  persistKimiConfig?: () => void;
  safeTrustedRoot: (requestedRoot?: unknown) => string;
  indexRun?: (record: Record<string, unknown>, ctx?: Record<string, unknown>) => void;
  requireIdempotencyKey?: (response: HttpResponseLike, context: RequestContextLike) => boolean;
  sendCachedOrStore?: (
    response: HttpResponseLike,
    cacheKey: string,
    fingerprint: string | undefined,
    status: number,
    payload: unknown,
  ) => boolean;
};
