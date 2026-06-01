import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readableBody, recordValue } from './host-http.js';
import type { KimiTextResult } from '../../src/kimi/api-runner.js';

export type AgentModelCallInput = {
  kimiConfig?: {
    provider?: string;
    baseUrl?: string;
    model?: string;
    apiKey?: string;
    fallbacks?: unknown;
  };
  messages?: Array<{ role?: string; tool_call_id?: string }>;
  tools?: Array<{ function?: { name?: string } }>;
};

export async function noopKimiChatRunner(): Promise<KimiTextResult> {
  return {
    ok: true,
    provider: 'test',
    model: 'test-model',
    mode: 'chat',
    text: '',
    durationMs: 0,
  };
}

const startEventSchema = z.object({
  runId: z.string().min(1),
}).passthrough();

const runRecordSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
  configSnapshot: z.object({
    provider: z.string().optional(),
    baseUrl: z.string().optional(),
    apiKey: z.unknown().optional(),
    fallbacks: z.array(z.object({
      hasKey: z.boolean().optional(),
      apiKey: z.unknown().optional(),
    }).passthrough()).optional(),
  }).passthrough(),
}).passthrough();

const kimiInfoSchema = z.object({
  provider: z.string().optional(),
  model: z.string().optional(),
}).passthrough();

export async function readAgentStream(response: Response): Promise<string> {
  const reader = readableBody(response, 'agent stream response').getReader();
  const decoder = new TextDecoder();
  let output = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    output += decoder.decode(value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

export function postAgentStream(base: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/agent/chat/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function startRunId(streamText: string): string {
  const match = /event: start\s+data: ([^\n]+)/.exec(streamText);
  assert.ok(match?.[1], 'agent stream should include a start event with JSON data');
  return startEventSchema.parse(JSON.parse(match[1]) as unknown).runId;
}

export function readRunRecord(root: string, runId: string): z.infer<typeof runRecordSchema> {
  const raw = fs.readFileSync(path.join(root, '.AgentCowork', 'runs', `${runId}.json`), 'utf8');
  return runRecordSchema.parse(JSON.parse(raw) as unknown);
}

export async function readKimiInfo(base: string): Promise<z.infer<typeof kimiInfoSchema> & { raw: string }> {
  const raw = await (await fetch(`${base}/api/kimi/info`)).text();
  const parsed = kimiInfoSchema.parse(JSON.parse(raw) as unknown);
  return { ...parsed, raw };
}

export function toolNames(tools: AgentModelCallInput['tools']): string[] {
  return Array.isArray(tools)
    ? tools.map((tool) => String(recordValue(tool.function || {}, 'agent tool function').name || ''))
    : [];
}

export function hasToolResult(messages: AgentModelCallInput['messages'], toolCallId: string): boolean {
  return Array.isArray(messages)
    && messages.some((message) => message.role === 'tool' && message.tool_call_id === toolCallId);
}
