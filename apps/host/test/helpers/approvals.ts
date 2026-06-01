import assert from 'node:assert/strict';
import { z } from 'zod';
import { createApprovalRegistry } from '../../src/runtime/approvals.js';
import type { ApprovalRegistry as AgentApprovalRegistry } from '../../src/kimi/agent/approval-gate.js';
import type { ModelCall } from '../../src/kimi/agent/model-resilience.js';
import type { ApprovalRegistry as RuntimeApprovalRegistry } from '../../src/runtime/approvals.js';
import type { AgentTool } from '../../src/kimi/agent/tool-call-executor.js';

const approvalEventSchema = z.object({
  id: z.string().min(1),
}).passthrough();

const approvalPayloadSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
}).passthrough();

export const approvalOkResponseSchema = z.object({
  ok: z.boolean(),
}).passthrough();

export const approvalErrorResponseSchema = z.object({
  error: z.string(),
}).passthrough();

export const approvalBatchResponseSchema = z.object({
  context: z.object({
    tenantId: z.string().optional(),
    userId: z.string().optional(),
  }).passthrough(),
  ids: z.array(z.string()),
  ok: z.boolean(),
  resolved: z.number(),
  results: z.array(z.object({
    id: z.string(),
    ok: z.boolean(),
  })),
  decision: z.string(),
}).passthrough();

export function callThenAnswer(toolName: string, args: Record<string, unknown> = {}): ModelCall {
  let calls = 0;
  return async () => {
    calls += 1;
    if (calls === 1) {
      return {
        content: '',
        tool_calls: [{ id: 'c1', function: { name: toolName, arguments: JSON.stringify(args) } }],
      };
    }
    return { content: '完成。' };
  };
}

export function tool(name: string, risk: string, onRun: () => void): AgentTool {
  return {
    name,
    risk,
    description: name,
    parameters: { type: 'object', properties: {} },
    handler: async () => {
      onRun();
      return { ok: true };
    },
  };
}

export function mutatingTool(name: string, risk: string, onRun: () => void): AgentTool {
  return {
    ...tool(name, risk, onRun),
    mutating: true,
  };
}

export function createAgentApprovalRegistry(): RuntimeApprovalRegistry & AgentApprovalRegistry {
  return createApprovalRegistry() as RuntimeApprovalRegistry & AgentApprovalRegistry;
}

export function parseApprovalPayload(payload: unknown): z.infer<typeof approvalPayloadSchema> {
  return approvalPayloadSchema.parse(payload);
}

export async function parseJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(await response.json() as unknown);
}

export function scopedJsonHeaders(tenantId: string, userId: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-tenant-id': tenantId,
    'x-user-id': userId,
  };
}

// The stream can split SSE frames across chunks, so keep reading until the
// approval_request frame is complete and validated.
export async function readApprovalRequest(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<{ approvalId: string; text: string }> {
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    const match = /event: approval_request\r?\ndata: ([^\r\n]+)/.exec(text);
    if (match) {
      const raw = match[1];
      assert.ok(raw, 'approval_request SSE frame should include JSON data');
      return { approvalId: approvalEventSchema.parse(JSON.parse(raw) as unknown).id, text };
    }
  }
  text += decoder.decode();
  throw new Error('agent stream should emit approval_request');
}

export async function drainStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  initialText = '',
): Promise<string> {
  const decoder = new TextDecoder();
  let text = initialText;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
