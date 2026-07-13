import assert from 'node:assert/strict';
import { z } from 'zod';
import type { AgentTool } from '../../src/engine/agent-tools.js';

export type CallableAgentTool = AgentTool & { handler: NonNullable<AgentTool['handler']> };

export type EmittedEvent = {
  type: string;
  payload: unknown;
};

const globResultSchema = z.object({
  matches: z.array(z.string()),
}).loose();

const grepResultSchema = z.object({
  hits: z.array(z.unknown()),
}).loose();

const readResultSchema = z.object({
  content: z.string(),
}).loose();

const writeResultSchema = z.object({
  ok: z.boolean(),
}).loose();

const editResultSchema = z.object({
  replacements: z.number(),
}).loose();

const shellResultSchema = z.object({
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
}).loose();

const todoEventSchema = z.object({
  status: z.string(),
  text: z.string(),
}).loose();

const toolResultEventSchema = z.object({
  name: z.string(),
  durationMs: z.number(),
}).loose();

const planProposalSchema = z.object({
  id: z.string().min(1),
}).loose();

const todoSnapshotSchema = z.object({
  todos: z.array(z.object({
    text: z.string(),
  }).loose()),
}).loose();

export const runsIndexSchema = z.object({
  runs: z.array(z.object({
    type: z.string().optional(),
  }).loose()).optional(),
}).loose();

export function agentTool(tools: AgentTool[], name: string): CallableAgentTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool?.handler, `agent tool ${name} should be present`);
  return tool as CallableAgentTool;
}

export function parseGlobResult(result: unknown): z.infer<typeof globResultSchema> {
  return globResultSchema.parse(result);
}

export function parseGrepResult(result: unknown): z.infer<typeof grepResultSchema> {
  return grepResultSchema.parse(result);
}

export function parseReadResult(result: unknown): z.infer<typeof readResultSchema> {
  return readResultSchema.parse(result);
}

export function parseWriteResult(result: unknown): z.infer<typeof writeResultSchema> {
  return writeResultSchema.parse(result);
}

export function parseEditResult(result: unknown): z.infer<typeof editResultSchema> {
  return editResultSchema.parse(result);
}

export function parseShellResult(result: unknown): z.infer<typeof shellResultSchema> {
  return shellResultSchema.parse(result);
}

export function parsePlanProposal(payload: unknown): z.infer<typeof planProposalSchema> {
  return planProposalSchema.parse(payload);
}

export function hasTodoEvent(events: EmittedEvent[], status: string, text: string): boolean {
  return events.some((event) => {
    if (event.type !== 'todo_update') return false;
    const parsed = todoEventSchema.safeParse(event.payload);
    return parsed.success && parsed.data.status === status && parsed.data.text === text;
  });
}

export function hasToolResultEvent(events: EmittedEvent[], name: string): boolean {
  return events.some((event) => {
    if (event.type !== 'tool_result') return false;
    const parsed = toolResultEventSchema.safeParse(event.payload);
    return parsed.success && parsed.data.name === name && Number.isFinite(parsed.data.durationMs);
  });
}

export function hasTodoSnapshotText(events: EmittedEvent[], text: string): boolean {
  return events.some((event) => {
    if (event.type !== 'todo_snapshot') return false;
    const parsed = todoSnapshotSchema.safeParse(event.payload);
    return parsed.success && parsed.data.todos.some((todo) => todo.text === text);
  });
}
