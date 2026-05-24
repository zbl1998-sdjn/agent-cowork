import { getJson, newIdempotencyKey, postJson } from './transport';

export interface ToolDescriptor {
  name: string;
  description: string;
  source: string;
  risk?: string;
  mutating?: boolean;
  requiresApproval?: boolean;
  inputSchema?: unknown;
  score?: number;
}

export async function listTools(): Promise<{ tools: ToolDescriptor[]; mcpServers: string[] }> {
  return getJson('/api/tools');
}

export async function searchTools(query: string, limit = 10): Promise<ToolDescriptor[]> {
  const res = await getJson<{ tools: ToolDescriptor[] }>(
    `/api/tools/search?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return res.tools || [];
}

export async function callTool<T = unknown>(
  name: string,
  args: Record<string, unknown> = {},
  trustedRoot?: string,
): Promise<{ name: string; result: T }> {
  return postJson('/api/tools/call', { name, args, trustedRoot, idempotencyKey: newIdempotencyKey('tool') });
}

export interface SubagentStep {
  tool: string;
  args?: Record<string, unknown>;
  note?: string;
}

export interface SubagentStepResult {
  index: number;
  tool: string;
  status: 'succeeded' | 'failed';
  summary?: unknown;
  error?: string;
}

export interface SubagentResult {
  runId: string;
  ok: boolean;
  goal: string;
  steps: SubagentStepResult[];
}

export async function runSubagent(goal: string, steps: SubagentStep[], trustedRoot?: string): Promise<SubagentResult> {
  return postJson('/api/subagent/run', { goal, steps, trustedRoot, idempotencyKey: newIdempotencyKey('agent') });
}

export interface ConnectorInfo {
  id: string;
  name: string;
  description: string;
  keywords?: string[];
  builtin?: boolean;
  command?: string;
  args?: string[];
  install?: string;
  score?: number;
}

export async function listConnectors(): Promise<{ connectors: ConnectorInfo[]; connected: string[] }> {
  return getJson('/api/connectors');
}

export async function suggestConnectors(query: string, limit = 5): Promise<ConnectorInfo[]> {
  const res = await getJson<{ connectors: ConnectorInfo[] }>(
    `/api/connectors/suggest?q=${encodeURIComponent(query)}&limit=${limit}`,
  );
  return res.connectors || [];
}

export interface ConnectResult {
  name: string;
  connected: number;
  errors?: Array<{ name?: string; error: string }>;
  mcpServers: string[];
}

export async function connectConnector(
  body: { id?: string; name?: string; command?: string; args?: string[]; trustedRoot?: string },
): Promise<ConnectResult> {
  return postJson('/api/connectors/connect', { ...body, idempotencyKey: newIdempotencyKey('conn') });
}
