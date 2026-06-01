import assert from 'node:assert/strict';
import path from 'node:path';
import { z } from 'zod';
import { createCredentialStore } from '../../src/security/credential-store.js';

export type OAuthFetchCall = {
  url: string;
  body: string;
};

const approvalResponseSchema = z.object({
  approvalId: z.string(),
  scopes: z.array(z.string()).optional(),
  permissions: z.array(z.object({
    id: z.string(),
    risk: z.string().optional(),
  }).passthrough()).optional(),
}).passthrough();

const startResponseSchema = z.object({
  provider: z.string().optional(),
  sessionId: z.string(),
  userCode: z.string(),
  scopes: z.array(z.string()).optional(),
}).passthrough();

const completeResponseSchema = z.object({
  connected: z.boolean().optional(),
  status: z.string().optional(),
  account: z.object({
    login: z.string().optional(),
  }).passthrough().optional(),
}).passthrough();

const oauthStatusSchema = z.object({
  connected: z.boolean().optional(),
  configured: z.boolean().optional(),
  accounts: z.array(z.object({
    accountId: z.string(),
  }).passthrough()).optional(),
  requiredEnv: z.array(z.string()).optional(),
  configurationMessage: z.string().optional(),
}).passthrough();

export function testProtector(): { protect(text: unknown): string; unprotect(text: unknown): string } {
  return {
    protect(text: unknown) {
      return `sealed:${Buffer.from(String(text), 'utf8').toString('base64')}`;
    },
    unprotect(text: unknown) {
      return Buffer.from(String(text).slice('sealed:'.length), 'base64').toString('utf8');
    },
  };
}

export function createOAuthTestStore(root: string): {
  credentialFile: string;
  credentialStore: ReturnType<typeof createCredentialStore>;
} {
  const credentialFile = path.join(root, 'credentials.json');
  return {
    credentialFile,
    credentialStore: createCredentialStore({ filePath: credentialFile, protector: testProtector() }),
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function firstOAuthCall(calls: readonly OAuthFetchCall[]): OAuthFetchCall {
  const call = calls[0];
  assert.ok(call, 'expected at least one OAuth fetch call');
  return call;
}

export function parseApprovalResponse(body: Record<string, unknown>): z.infer<typeof approvalResponseSchema> {
  return approvalResponseSchema.parse(body);
}

export function parseStartResponse(body: Record<string, unknown>): z.infer<typeof startResponseSchema> {
  return startResponseSchema.parse(body);
}

export function parseCompleteResponse(body: Record<string, unknown>): z.infer<typeof completeResponseSchema> {
  return completeResponseSchema.parse(body);
}

export function parseOAuthStatus(body: Record<string, unknown>): z.infer<typeof oauthStatusSchema> {
  return oauthStatusSchema.parse(body);
}
