import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createServer, type ServerConfig } from '../../src/server.js';
import { createAesGcmProtector } from '../../src/security/credential-store.js';
import { bind, close } from './host-http.js';

export const CONFIG_SECRET = 'sk-config-test-DO-NOT-ECHO-123456';
export const FALLBACK_SECRET = 'sk-fallback-secret-DO-NOT-ECHO-123456';
export const TEST_LOCAL_MODEL_CONFIG = Object.freeze({
  provider: 'openai/local',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'fake',
  securityMode: 'local_strict',
});

export const TEST_LOCAL_HOST_MODEL_CONFIG = Object.freeze({
  kimiProvider: TEST_LOCAL_MODEL_CONFIG.provider,
  kimiBaseUrl: TEST_LOCAL_MODEL_CONFIG.baseUrl,
  kimiModel: TEST_LOCAL_MODEL_CONFIG.model,
  securityMode: 'controlled_hybrid',
});

const KIMI_CONFIG_TEST_PROTECTOR = createAesGcmProtector({
  keyMaterial: 'dummy-kimi-config-route-test-protector-key',
});

const fallbackStatusSchema = z.object({
  provider: z.string().optional(),
  hasKey: z.boolean().optional(),
  apiKey: z.unknown().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
}).loose();

const providerStateSchema = z.object({
  provider: z.string(),
  configured: z.boolean(),
  enabled: z.boolean(),
  hasKey: z.boolean(),
  baseUrl: z.string(),
  model: z.string(),
  policyDecision: z.enum(['allow', 'deny', 'needs_approval']),
  reasonCode: z.string(),
  reason: z.string(),
}).loose();

export const kimiConfigResponseSchema = z.object({
  provider: z.string().optional(),
  configured: z.boolean().optional(),
  hasKey: z.boolean().optional(),
  chatEnabled: z.boolean().optional(),
  planEnabled: z.boolean().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
  apiKey: z.unknown().optional(),
  fallbacks: z.array(fallbackStatusSchema).optional(),
  providerStates: z.array(providerStateSchema).optional(),
}).loose();

export const kimiErrorResponseSchema = z.object({
  error: z.string(),
}).loose();

const persistedConfigSchema = z.object({
  kimiApi: z.object({
    provider: z.string().optional(),
    apiKey: z.string().optional(),
    baseUrl: z.string().optional(),
    model: z.string().optional(),
    fallbacks: z.array(z.object({
      provider: z.string().optional(),
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
    }).loose()).optional(),
    providerProfiles: z.record(z.string(), z.object({
      apiKey: z.string().optional(),
      baseUrl: z.string().optional(),
      model: z.string().optional(),
    }).loose()).optional(),
  }).loose(),
}).loose();

export type KimiConfigResponse = z.infer<typeof kimiConfigResponseSchema>;
export type PersistedKimiConfig = z.infer<typeof persistedConfigSchema>;

export async function withKimiConfigServer(
  config: ServerConfig,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer({
    requireAuth: false,
    kimiConfigProtector: KIMI_CONFIG_TEST_PROTECTOR,
    ...config,
  });
  const baseUrl = await bind(server);
  try {
    await fn(baseUrl);
  } finally {
    await close(server);
  }
}

export function postKimiConfig(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/kimi/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function postKimiTest(baseUrl: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}/api/kimi/test`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function readKimiInfo(baseUrl: string): Promise<{ raw: string; body: KimiConfigResponse }> {
  const raw = await (await fetch(`${baseUrl}/api/kimi/info`)).text();
  return { raw, body: kimiConfigResponseSchema.parse(JSON.parse(raw) as unknown) };
}

export async function readConfigResponse(response: Response): Promise<{ raw: string; body: KimiConfigResponse }> {
  const raw = await response.text();
  return { raw, body: kimiConfigResponseSchema.parse(JSON.parse(raw) as unknown) };
}

export async function readErrorResponse(response: Response): Promise<z.infer<typeof kimiErrorResponseSchema>> {
  return kimiErrorResponseSchema.parse(await response.json() as unknown);
}

export function readPersistedConfig(trustedRoot: string): PersistedKimiConfig {
  const cfgPath = path.join(trustedRoot, '.AgentCowork', 'config.json');
  return persistedConfigSchema.parse(JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as unknown);
}

export function persistedConfigPath(trustedRoot: string): string {
  return path.join(trustedRoot, '.AgentCowork', 'config.json');
}
