import assert from 'node:assert/strict';
import { z } from 'zod';
import { jsonRequest } from './host-http.js';

export type VizRenderBody = Record<string, unknown>;

const vizArtifactIdSchema = z.string().regex(/^viz[-_a-zA-Z0-9]+$/);

const previewResponseSchema = z.object({
  id: vizArtifactIdSchema,
  fileOperationApprovalId: z.string().regex(/^fop_/),
}).passthrough();

const persistedRenderResponseSchema = z.object({
  persisted: z.literal(true),
  id: vizArtifactIdSchema,
  html: z.string(),
  dataUrl: z.string(),
  viewUrl: z.string(),
  idempotentReplay: z.boolean().optional(),
}).passthrough();

const inlineRenderResponseSchema = z.object({
  persisted: z.literal(false),
  html: z.string(),
}).passthrough();

export const artifactDataResponseSchema = z.object({
  dataSource: z.object({
    type: z.string(),
    tool: z.string().optional(),
  }).passthrough().optional(),
  viz: z.object({
    kind: z.string(),
    data: z.unknown(),
  }).passthrough(),
}).passthrough();

export async function approveVizRender(base: string, body: VizRenderBody): Promise<VizRenderBody> {
  const preview = await jsonRequest(base, '/api/viz/render/preview', {
    method: 'POST',
    body,
  });
  assert.equal(preview.status, 200);
  const parsed = previewResponseSchema.parse(preview.body);
  return {
    ...body,
    id: parsed.id,
    fileOperationApprovalId: parsed.fileOperationApprovalId,
  };
}

export function parsePersistedRenderResponse(body: Record<string, unknown>): z.infer<typeof persistedRenderResponseSchema> {
  return persistedRenderResponseSchema.parse(body);
}

export function parseInlineRenderResponse(body: Record<string, unknown>): z.infer<typeof inlineRenderResponseSchema> {
  return inlineRenderResponseSchema.parse(body);
}

export async function textRequest(base: string, route: string): Promise<{ status: number; type: string; body: string }> {
  const response = await fetch(`${base}${route}`);
  return {
    status: response.status,
    type: response.headers.get('content-type') || '',
    body: await response.text(),
  };
}
