import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { createServer, type ServerConfig } from '../../src/server.js';
import { bind, close } from './host-http.js';

export const CONFIG_SECRET = 'sk-config-test-DO-NOT-ECHO-123456';
export const FALLBACK_SECRET = 'sk-fallback-secret-DO-NOT-ECHO-123456';

const fallbackStatusSchema = z.object({
  provider: z.string().optional(),
  hasKey: z.boolean().optional(),
  apiKey: z.unknown().optional(),
  baseUrl: z.string().optional(),
  model: z.string().optional(),
}).passthrough();

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
}).passthrough();

export const kimiErrorResponseSchema = z.object({
  error: z.string(),
}).passthrough();

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
    }).passthrough()).optional(),
  }).passthrough(),
}).passthrough();

export type KimiConfigResponse = z.infer<typeof kimiConfigResponseSchema>;
export type PersistedKimiConfig = z.infer<typeof persistedConfigSchema>;

export async function withKimiConfigServer(
  config: ServerConfig,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createServer({ requireAuth: false, ...config });
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
