import path from 'node:path';
import { handleArtifactRoutes } from './artifact-routes.js';
import { handleAuthRoutes } from './auth-routes.js';
import { handleClarifyRoutes } from './clarify-routes.js';
import { handleConnectorRoutes } from './connector-routes.js';
import { handleConversationRoutes } from './conversation-routes.js';
import { handleMemoryRoutes } from './memory-routes.js';
import { handlePlanRoutes } from './plan-routes.js';
import { handlePromptRoutes } from './prompt-routes.js';
import { handleRecipeRoutes } from './recipe-routes.js';
import { handleRunRoutes } from './run-routes.js';
import { handleSandboxRoutes } from './sandbox-routes.js';
import { handleScheduleRoutes } from './schedule-routes.js';
import { handleSearchRoutes } from './search-routes.js';
import { handleSkillRoutes } from './skill-routes.js';
import { handleSystemRoutes } from './system-routes.js';
import { handleToolRoutes } from './tool-routes.js';
import { handleVizRoutes } from './viz-routes.js';
import { handleWorkspaceFileRoutes } from './workspace-file-routes.js';
import { handleApprovalRoutes } from './approval-routes.js';
import { handleKimiRoutes } from './kimi-routes.js';

export async function handleRouteChain({ request, response, pathname, requestUrl, requestContext, state, server }) {
  if (await handleSystemRoutes({ request, response, pathname, requestContext, state })) return true;
  if (await handleAuthRoutes({ request, response, pathname, requestContext, authStore: state.authStore })) return true;
  if (await handleApprovalRoutes({ request, response, pathname, requestContext, approvalRegistry: state.approvalRegistry })) return true;
  if (await handleRunRoutes({
    request,
    response,
    pathname,
    requestUrl,
    requestContext,
    runStoreRoot: state.runStoreRoot,
    runsIndex: state.runsIndex,
    runEvents: state.runEvents,
  })) return true;
  if (await handleRecipeRoutes({
    request,
    response,
    pathname,
    requestContext,
    runStoreRoot: state.runStoreRoot,
    runEvents: state.runEvents,
    runsIndex: state.runsIndex,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot: state.safeTrustedRoot,
    fileOperationApprovals: state.fileOperationApprovals,
  })) return true;
  if (await handleMemoryRoutes({
    request,
    response,
    pathname,
    requestUrl,
    requestContext,
    trustedRootDefault: state.trustedRootDefault,
    memoryStore: state.memoryStore,
  })) return true;
  if (await handleConversationRoutes({
    request,
    response,
    pathname,
    requestUrl,
    requestContext,
    trustedRootDefault: state.trustedRootDefault,
    conversationStore: state.conversationStore,
  })) return true;
  if (await handleArtifactRoutes({
    request,
    response,
    pathname,
    requestUrl,
    requestContext,
    trustedRootDefault: state.trustedRootDefault,
    safeTrustedRoot: state.safeTrustedRoot,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
  })) return true;
  if (await handlePromptRoutes({ request, response, pathname, requestContext, state })) return true;
  if (await handleSearchRoutes({ request, response, pathname, requestContext, state })) return true;
  if (await handleKimiRoutes({ request, response, pathname, requestContext, state })) return true;
  if (await handleWorkspaceFileRoutes({
    request,
    response,
    pathname,
    requestContext,
    trustedRootDefault: state.trustedRootDefault,
    config: state.config,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot: state.safeTrustedRoot,
    fileOperationApprovals: state.fileOperationApprovals,
  })) return true;
  if (await handleSandboxRoutes({
    request,
    response,
    pathname,
    requestContext,
    sandbox: state.sandbox,
    sandboxEnabled: state.sandboxEnabled,
    sandboxLimits: state.sandboxLimits,
    runStoreRoot: state.runStoreRoot,
    runsIndex: state.runsIndex,
    runEvents: state.runEvents,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot: state.safeTrustedRoot,
    allowUnsafeDirectSandboxRoutes: state.config.allowUnsafeDirectSandboxRoutes === true,
  })) return true;
  if (await handleToolRoutes({
    request,
    response,
    pathname,
    requestUrl,
    requestContext,
    toolRegistry: state.toolRegistry,
    runStoreRoot: state.runStoreRoot,
    runEvents: state.runEvents,
    runsIndex: state.runsIndex,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot: state.safeTrustedRoot,
  })) return true;
  if (await handleVizRoutes({
    request,
    response,
    pathname,
    requestUrl,
    requestContext,
    trustedRootDefault: state.trustedRootDefault,
    safeTrustedRoot: state.safeTrustedRoot,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
  })) return true;
  if (await handleSkillRoutes({ request, response, pathname, requestContext, skillRegistry: state.skillRegistry })) return true;
  if (await handlePlanRoutes({ request, response, pathname, requestContext, toolRegistry: state.toolRegistry, planner: state.config.planner })) return true;
  if (await handleClarifyRoutes({ request, response, pathname, requestContext, clarifications: state.clarifications })) return true;
  if (await handleConnectorRoutes({
    request,
    response,
    pathname,
    requestUrl,
    requestContext,
    toolRegistry: state.toolRegistry,
    safeTrustedRoot: state.safeTrustedRoot,
    fsServerPath: path.join(state.hostSrcDir, '../mcp-servers/fs-server.mjs'),
    connectMcp: (servers) => server.connectMcpServers(servers),
  })) return true;
  if (await handleScheduleRoutes({
    request,
    response,
    pathname,
    requestUrl,
    requestContext,
    activeScheduler: state.activeScheduler,
    cacheKeyFor: state.cacheKeyFor,
    requireIdempotencyKey: state.requireIdempotencyKey,
    sendCachedOrStore: state.sendCachedOrStore,
    safeTrustedRoot: state.safeTrustedRoot,
  })) return true;
  return false;
}
