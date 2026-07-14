import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createServer, type HostServer, type ServerConfig } from '../apps/host/src/server.js';
import { createApprovalRegistry, type ApprovalRegistry } from '../apps/host/src/runtime/approvals.js';
import { createCancellationRegistry, type CancellationRegistry } from '../apps/host/src/runtime/cancellation.js';
import {
  createConcurrencyLimiter,
  type ConcurrencyLimiter,
} from '../apps/host/src/runtime/concurrency.js';
import { writeMemorySettings } from '../apps/host/src/memory/memory-control.js';
import type { BenchmarkConfig } from './bench-metrics.js';

export type OfflineServerContext = {
  server: HostServer;
  baseUrl: string;
  startupMs: number;
  approvals: ApprovalRegistry;
  cancellation: CancellationRegistry;
  concurrency: ConcurrencyLimiter;
  modelCallCount: () => number;
};

const BENCH_SANDBOX_STARTUP: NonNullable<ServerConfig['sandboxStartup']> = {
  options: { backend: 'local' },
  info: {
    requestedBackend: 'local',
    selectedBackend: 'local',
    networkIsolated: false,
    fallback: false,
    fallbackReason: null,
    userMessage: 'benchmark disables tool execution',
    backends: {
      docker: { available: false, usable: false, networkIsolated: true, detail: '', reason: 'disabled' },
      wsl: { available: false, usable: false, networkIsolated: false, detail: '', reason: 'disabled' },
      local: { available: true, usable: true, networkIsolated: false },
    },
  },
};

const rejectInjectedFetch: typeof fetch = async () => {
  throw new Error('benchmark boundary rejected an injected outbound fetch');
};

function makeServerConfig(
  workspaceRoot: string,
  config: BenchmarkConfig,
  approvals: ApprovalRegistry,
  cancellation: CancellationRegistry,
  concurrency: ConcurrencyLimiter,
  onModelCall: () => void,
): ServerConfig {
  const stateRoot = path.join(workspaceRoot, '.AgentCowork');
  fs.mkdirSync(stateRoot, { recursive: true });
  return {
    trustedRoot: workspaceRoot,
    modelConfigFile: path.join(stateRoot, 'bench-kimi.json'),
    credentialStorePath: path.join(stateRoot, 'bench-credentials.json'),
    storeBackend: 'file',
    databaseUrl: null,
    persistAuth: false,
    rateLimit: false,
    requireAuth: false,
    enableScheduler: false,
    startScheduler: false,
    enableSandbox: false,
    sandboxStartup: BENCH_SANDBOX_STARTUP,
    connectMcpOnStart: false,
    mcpServers: [],
    modelProvider: 'openai/local',
    modelBaseUrl: 'http://127.0.0.1:1/v1',
    model: 'benchmark-injected-model',
    securityMode: 'controlled_hybrid',
    fetchImpl: rejectInjectedFetch,
    oauthFetch: rejectInjectedFetch,
    approvalRegistry: approvals,
    cancellation,
    agentConcurrency: concurrency,
    modelChatRunner: async () => ({
      ok: true as const,
      provider: 'benchmark-injected',
      model: 'benchmark-injected-model',
      mode: 'chat',
      text: 'completed',
      durationMs: 0,
    }),
    agentModelCall: async () => {
      onModelCall();
      await new Promise((resolve) => setTimeout(resolve, config.mockModelDelayMs));
      return {
        content: 'completed',
        usage: { prompt_tokens: 16, completion_tokens: 1, total_tokens: 17 },
      };
    },
  };
}

export async function startOfflineBenchmarkServer(
  workspaceRoot: string,
  config: BenchmarkConfig,
): Promise<OfflineServerContext> {
  fs.mkdirSync(workspaceRoot, { recursive: true });
  writeMemorySettings(
    workspaceRoot,
    { paused: true },
    { tenantId: 'tenant_local', userId: 'user_local' },
  );
  const approvals = createApprovalRegistry();
  const cancellation = createCancellationRegistry();
  const concurrency = createConcurrencyLimiter({
    maxConcurrent: config.taskConcurrency,
    maxPerTenant: config.taskConcurrency,
  });
  let modelCalls = 0;
  const started = performance.now();
  const server = createServer(makeServerConfig(
    workspaceRoot,
    config,
    approvals,
    cancellation,
    concurrency,
    () => { modelCalls += 1; },
  ));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  await server.ready();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('benchmark server did not bind a TCP port');
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
    startupMs: performance.now() - started,
    approvals,
    cancellation,
    concurrency,
    modelCallCount: () => modelCalls,
  };
}

export async function closeOfflineBenchmarkServer(context: OfflineServerContext): Promise<void> {
  context.server.closeMcp();
  await new Promise<void>((resolve, reject) => {
    context.server.close((error?: Error) => (error ? reject(error) : resolve()));
  });
}
