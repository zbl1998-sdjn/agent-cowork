// 路由链(host · L3 routes):把 /api 子路由串成责任链,由首个匹配项短路,再由 L4 server.js 挂载。
// 依赖:同层 handleXRoutes。导出:handleRouteChain。
import path from 'node:path';
import { handleArtifactRoutes } from './artifact-routes.js';
import { handleArtifactEditorRoutes } from './artifact-editor-routes.js';
import { handleArtifactVersionRoutes } from './artifact-version-routes.js';
import { handleAuthRoutes } from './auth-routes.js';
import { handleClarifyRoutes } from './clarify-routes.js';
import { handleConnectorRoutes } from './connector-routes.js';
import { handleConversationRoutes } from './conversation-routes.js';
import { handleFolderGrantRoutes } from './folder-grant-routes.js';
import { handleMemoryRoutes } from './memory-routes.js';
import { handleMemoryKnowledgeRoutes } from './memory-knowledge-routes.js';
import { handleOnboardingRoutes } from './onboarding-routes.js';
import { handleOnlyOfficeRoutes } from './onlyoffice-routes.js';
import { handleOrchestratorRoutes } from './orchestrator-routes.js';
import { handlePlanRoutes } from './plan-routes.js';
import { handleProjectRoutes } from './project-routes.js';
import { handlePromptRoutes } from './prompt-routes.js';
import { handleRecipeRoutes } from './recipe-routes.js';
import { handleRunRoutes } from './run-routes.js';
import { handleSandboxRoutes } from './sandbox-routes.js';
import { handleScheduleRoutes } from './schedule-routes.js';
import { handleSearchRoutes } from './search-routes.js';
import { handleSkillRoutes } from './skill-routes.js';
import { handleApprovalRulesRoutes } from './approval-rules-routes.js';
import { handleSystemRoutes } from './system-routes.js';
import { handleToolRoutes } from './tool-routes.js';
import { handleVizRoutes } from './viz-routes.js';
import { handleWorkspaceFileRoutes } from './workspace-file-routes.js';
import { handleApprovalRoutes } from './approval-routes.js';
import { handleAgentEngineRoutes } from './agent-engine-routes.js';
import { omitUndefined } from '../util/object.js';
import { readRunRecord } from '../runtime/run-store.js';
import { headerValue, type HttpRequestLike, type HttpResponseLike, type RequestContext } from '../http/request-utils.js';
import type { HostState } from '../runtime/host-state-types.js';
type RouteHandlerOptions<T> = T extends (options: infer Options) => Promise<boolean> ? Options : never;
type RouteRequest = HttpRequestLike & { method?: string };
type ConnectorOptions = RouteHandlerOptions<typeof handleConnectorRoutes>;
type ConnectMcp = NonNullable<ConnectorOptions['connectMcp']>;
type RouteServer = { connectMcpServers(servers: unknown): Promise<unknown> };
type RouteChainOptions = {
  request: RouteRequest;
  response: HttpResponseLike;
  pathname: string;
  requestUrl: URL;
  requestContext: RequestContext;
  state: HostState;
  server: RouteServer;
};
function routeOptions<T>(options: Record<string, unknown>): T { return omitUndefined(options) as T; }
export async function handleRouteChain({
  request,
  response,
  pathname,
  requestUrl,
  requestContext,
  state,
  server,
}: RouteChainOptions): Promise<boolean> {
  const base = { request, response, pathname, requestContext };
  const workspaceGrantId = headerValue(request, 'x-workspace-grant-id');
  const safeTrustedRoot = (requestedRoot?: unknown): string => state.safeTrustedRoot(requestedRoot, requestContext, workspaceGrantId);
  const requestState = { ...state, safeTrustedRoot } as HostState;
  if (await handleSystemRoutes(routeOptions<RouteHandlerOptions<typeof handleSystemRoutes>>({ ...base, requestUrl, state }))) return true;
  if (await handleAuthRoutes(routeOptions<RouteHandlerOptions<typeof handleAuthRoutes>>({ ...base, authStore: state.authStore, enrollmentPolicy: state.enrollmentPolicy, allowLocalGuestEnrollment: state.config.allowLocalGuestEnrollment === true && state.requireAuth === true && state.trustIdentityHeaders !== true && state.validateHost === true }))) return true;
  if (await handleApprovalRoutes(routeOptions<RouteHandlerOptions<typeof handleApprovalRoutes>>({ ...base, approvalRegistry: state.approvalRegistry }))) return true;
  if (await handleFolderGrantRoutes(routeOptions<RouteHandlerOptions<typeof handleFolderGrantRoutes>>({
    ...base,
    requestUrl,
    folderGrants: state.folderGrants,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
  }))) return true;
  if (await handleRunRoutes(routeOptions<RouteHandlerOptions<typeof handleRunRoutes>>({
    ...base,
    requestUrl,
    runStoreRoot: state.runStoreRoot,
    runsIndex: state.runsIndex,
    runEvents: state.runEvents,
  }))) return true;
  if (await handleOrchestratorRoutes(routeOptions<RouteHandlerOptions<typeof handleOrchestratorRoutes>>({
    ...base,
    runStoreRoot: state.runStoreRoot,
    runsIndex: state.runsIndex,
    runEvents: state.runEvents,
    toolRegistry: state.toolRegistry,
    modelConfig: state.agentModelConfig,
    fetchImpl: state.oauthFetch,
    cancellation: state.cancellation,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot,
  }))) return true;
  if (await handleRecipeRoutes(routeOptions<RouteHandlerOptions<typeof handleRecipeRoutes>>({
    ...base,
    runStoreRoot: state.runStoreRoot,
    runEvents: state.runEvents,
    runsIndex: state.runsIndex,
    recordReader: (runId: string) => readRunRecord(state.runStoreRoot, runId),
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot,
    fileOperationApprovals: state.fileOperationApprovals,
    // 模型已配置时,支持 AI 路径的 recipe(如会议纪要)走模型提取,否则回退模板。
    resolveModelConfig: () => (state.agentModelConfig?.configured ? state.agentModelConfig as unknown as Record<string, unknown> : null),
  }))) return true;
  if (await handleMemoryKnowledgeRoutes(routeOptions<RouteHandlerOptions<typeof handleMemoryKnowledgeRoutes>>({
    ...base, requestUrl, safeTrustedRoot,
  }))) return true;
  if (await handleMemoryRoutes(routeOptions<RouteHandlerOptions<typeof handleMemoryRoutes>>({
    ...base, requestUrl, safeTrustedRoot,
    memoryStore: state.memoryStore,
  }))) return true;
  if (await handleProjectRoutes(routeOptions<RouteHandlerOptions<typeof handleProjectRoutes>>({
    ...base,
    requestUrl,
    trustedRootDefault: state.trustedRootDefault,
    safeTrustedRoot,
    getProjectStore: state.getProjectStore,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
  }))) return true;
  if (await handleConversationRoutes(routeOptions<RouteHandlerOptions<typeof handleConversationRoutes>>({
    ...base,
    requestUrl,
    trustedRootDefault: state.trustedRootDefault,
    safeTrustedRoot,
    conversationStore: state.conversationStore,
  }))) return true;
  if (await handleArtifactRoutes(routeOptions<RouteHandlerOptions<typeof handleArtifactRoutes>>({
    ...base,
    requestUrl,
    trustedRootDefault: state.trustedRootDefault,
    safeTrustedRoot,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
  }))) return true;
  if (await handleArtifactEditorRoutes(routeOptions<RouteHandlerOptions<typeof handleArtifactEditorRoutes>>({
    ...base, trustedRootDefault: state.trustedRootDefault, safeTrustedRoot, cacheKeyFor: state.cacheKeyFor, requireIdempotencyKey: state.requireIdempotencyKey, sendCachedOrStore: state.sendCachedOrStore, fileOperationApprovals: state.fileOperationApprovals,
  }))) return true;
  if (await handleOnlyOfficeRoutes(routeOptions<RouteHandlerOptions<typeof handleOnlyOfficeRoutes>>({
    ...base, requestUrl, trustedRootDefault: state.trustedRootDefault, safeTrustedRoot, cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey, sendCachedOrStore: state.sendCachedOrStore,
    fileOperationApprovals: state.fileOperationApprovals, config: state.onlyOfficeConfig, fetchImpl: state.onlyOfficeFetch,
  }))) return true;
  if (await handleArtifactVersionRoutes(routeOptions<RouteHandlerOptions<typeof handleArtifactVersionRoutes>>({
    ...base, requestUrl, trustedRootDefault: state.trustedRootDefault, safeTrustedRoot, cacheKeyFor: state.cacheKeyFor, requireIdempotencyKey: state.requireIdempotencyKey, sendCachedOrStore: state.sendCachedOrStore, fileOperationApprovals: state.fileOperationApprovals, resolveSecurityMode: () => state.agentModelConfig?.securityMode,
  }))) return true;
  if (await handlePromptRoutes(routeOptions<RouteHandlerOptions<typeof handlePromptRoutes>>({ ...base, state: requestState }))) return true;
  if (await handleSearchRoutes(routeOptions<RouteHandlerOptions<typeof handleSearchRoutes>>({ ...base, state: requestState }))) return true;
  if (await handleAgentEngineRoutes({ ...base, state, safeTrustedRoot })) return true;
  if (await handleOnboardingRoutes(routeOptions<RouteHandlerOptions<typeof handleOnboardingRoutes>>({ request, response, pathname }))) return true;
  if (await handleWorkspaceFileRoutes(routeOptions<RouteHandlerOptions<typeof handleWorkspaceFileRoutes>>({
    ...base,
    trustedRootDefault: state.trustedRootDefault,
    config: state.config,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot,
    fileOperationApprovals: state.fileOperationApprovals,
  }))) return true;
  if (await handleSandboxRoutes(routeOptions<RouteHandlerOptions<typeof handleSandboxRoutes>>({
    ...base,
    sandbox: state.sandbox,
    sandboxEnabled: state.sandboxEnabled,
    sandboxLimits: state.sandboxLimits,
    sandboxStartup: state.sandboxStartup.info,
    runStoreRoot: state.runStoreRoot,
    runsIndex: state.runsIndex,
    runEvents: state.runEvents,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot,
    allowUnsafeDirectSandboxRoutes: state.config.allowUnsafeDirectSandboxRoutes === true,
  }))) return true;
  if (await handleToolRoutes(routeOptions<RouteHandlerOptions<typeof handleToolRoutes>>({
    ...base,
    requestUrl,
    toolRegistry: state.toolRegistry,
    runStoreRoot: state.runStoreRoot,
    runEvents: state.runEvents,
    runsIndex: state.runsIndex,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot,
  }))) return true;
  if (await handleVizRoutes(routeOptions<RouteHandlerOptions<typeof handleVizRoutes>>({
    ...base, requestUrl, safeTrustedRoot,
    trustedRootDefault: state.trustedRootDefault,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    toolRegistry: state.toolRegistry,
    fileOperationApprovals: state.fileOperationApprovals,
    resolveSecurityMode: () => state.agentModelConfig?.securityMode,
  }))) return true;
  if (await handleSkillRoutes(routeOptions<RouteHandlerOptions<typeof handleSkillRoutes>>({
    ...base, requestUrl, safeTrustedRoot,
    globalMutationAdmins: state.globalMutationAdmins,
    skillRegistry: state.skillRegistry,
  }))) return true;
  if (await handleApprovalRulesRoutes(routeOptions<RouteHandlerOptions<typeof handleApprovalRulesRoutes>>({
    ...base, requestUrl, safeTrustedRoot, globalMutationAdmins: state.globalMutationAdmins,
  }))) return true;
  if (await handlePlanRoutes(routeOptions<RouteHandlerOptions<typeof handlePlanRoutes>>({
    ...base,
    toolRegistry: state.toolRegistry,
    planner: state.config.planner,
  }))) return true;
  if (await handleClarifyRoutes(routeOptions<RouteHandlerOptions<typeof handleClarifyRoutes>>({ ...base, clarifications: state.clarifications }))) return true;
  if (await handleConnectorRoutes(routeOptions<RouteHandlerOptions<typeof handleConnectorRoutes>>({
    ...base,
    requestUrl,
    globalMutationAdmins: state.globalMutationAdmins,
    toolRegistry: state.toolRegistry,
    credentialStore: state.credentialStore,
    oauthPermissionApprovals: state.oauthPermissionApprovals,
    oauthSessions: state.oauthSessions,
    oauthFetch: state.oauthFetch,
    oauthConfig: state.oauthConfig,
    safeTrustedRoot,
    fsServerPath: path.join(state.hostSrcDir, '../mcp-servers/fs-server.ts'),
    fsServerRunnerPath: path.join(state.hostSrcDir, '../../../scripts/run-host-node.mjs'),
    connectMcp: (servers: Parameters<ConnectMcp>[0]) => server.connectMcpServers(servers),
  }))) return true;
  if (await handleScheduleRoutes(routeOptions<RouteHandlerOptions<typeof handleScheduleRoutes>>({
    ...base,
    requestUrl,
    activeScheduler: state.activeScheduler,
    validateRecipeSchedule: state.scheduleRecipeValidator,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot,
    workspaceGrantId,
  }))) return true;
  return false;
}
