// Typed host client. Mirrors the contract of the legacy `app-api-client.js`:
// absolute host URL resolution, Tauri-aware host bootstrap, JSON helpers, SSE
// subscription, and trusted-root `openPath`.

import type { RunEvent } from './types';
import { invoke as tauriInvoke } from '@tauri-apps/api/core';

const HOST_BASE = 'http://127.0.0.1:3017';

export function resolveUrl(route: string): string {
  if (/^https?:\/\//i.test(route)) return route;
  return `${HOST_BASE}${route.startsWith('/') ? '' : '/'}${route}`;
}

// We now ship with withGlobalTauri:false (no global window.__TAURI__ surface for
// a stray script to abuse). Tauri 2 still injects __TAURI_INTERNALS__, which is
// what @tauri-apps/api's invoke talks to; outside the shell there are none.
export function isDesktop(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isDesktop()) {
    throw new Error(`Tauri command "${command}" is unavailable outside the desktop shell`);
  }
  return tauriInvoke<T>(command, args);
}

async function probeHealth(): Promise<boolean> {
  try {
    const response = await fetch(resolveUrl('/health'));
    return response.ok;
  } catch {
    return false;
  }
}

// Start the bundled host (desktop) and wait until /health is ready.
export async function ensureHost(attempts = 40, intervalMs = 250): Promise<boolean> {
  if (isDesktop()) {
    try {
      await invoke('start_node_host');
    } catch {
      // already running -> no-op on the Rust side; health probe decides.
    }
  }
  for (let i = 0; i < attempts; i += 1) {
    if (await probeHealth()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

const hostReady = ensureHost().catch(() => false);

// ---- auth token (bearer) ----
// Persisted in localStorage so the desktop webview keeps you signed in across
// restarts. Injected as `Authorization: Bearer <token>` on every host request,
// which scopes all reads/writes to the logged-in user's tenant on the host.
const AUTH_TOKEN_KEY = 'kcw.authToken';

function readStoredToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(AUTH_TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

let authToken: string | null = readStoredToken();

export function getAuthToken(): string | null {
  return authToken;
}

export function setAuthToken(token: string | null): void {
  authToken = token && token.trim() ? token.trim() : null;
  try {
    if (authToken) globalThis.localStorage?.setItem(AUTH_TOKEN_KEY, authToken);
    else globalThis.localStorage?.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* storage unavailable (tests/SSR) -> in-memory only */
  }
}

function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  return authToken ? { ...base, authorization: `Bearer ${authToken}` } : { ...base };
}

async function parse<T>(response: Response, route: string): Promise<T> {
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error((payload as { error?: string }).error || `${route} returned ${response.status}`);
    (error as { status?: number }).status = response.status;
    throw error;
  }
  return payload as T;
}

export async function getJson<T>(route: string): Promise<T> {
  await hostReady;
  return parse<T>(await fetch(resolveUrl(route), { headers: authHeaders() }), route);
}

export interface PostBody {
  idempotencyKey?: string;
  [key: string]: unknown;
}

export async function postJson<T>(route: string, body: PostBody): Promise<T> {
  await hostReady;
  const headers: Record<string, string> = authHeaders({ 'content-type': 'application/json' });
  if (body.idempotencyKey) headers['idempotency-key'] = body.idempotencyKey;
  const response = await fetch(resolveUrl(route), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  return parse<T>(response, route);
}

// Generic JSON request for verbs other than GET/POST (PUT, DELETE).
async function sendJsonMethod<T>(method: string, route: string, body?: unknown): Promise<T> {
  await hostReady;
  const response = await fetch(resolveUrl(route), {
    method,
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return parse<T>(response, route);
}

// Subscribe to a run's SSE timeline. Returns an unsubscribe function.
// Subscribe to a run's SSE timeline. The native EventSource cannot send an
// Authorization header, so once the API requires auth it would 401. We instead
// stream over fetch (which carries the Bearer token) and parse SSE frames by
// hand, mirroring agentChatStream. Returns an unsubscribe (AbortController).
export function subscribeRunEvents(runId: string, onEvent: (event: RunEvent) => void): () => void {
  const controller = new AbortController();
  const types = new Set<string>([
    'user_message', 'assistant_start', 'progress', 'preview',
    'awaiting_approval', 'sources', 'assistant_end', 'sandbox_start', 'sandbox_end', 'tool_result',
  ]);
  void (async () => {
    try {
      await hostReady;
      const res = await fetch(resolveUrl(`/api/runs/${encodeURIComponent(runId)}/events`), {
        headers: authHeaders({ accept: 'text/event-stream' }),
        signal: controller.signal,
      });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const evMatch = /^event:\s*(.*)$/m.exec(frame);
          const dataMatch = /^data:\s*(.*)$/m.exec(frame);
          if (!evMatch) continue;
          const type = evMatch[1].trim();
          if (!types.has(type)) continue;
          try {
            const data = dataMatch ? JSON.parse(dataMatch[1]) : {};
            onEvent({ type, ...data } as RunEvent);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } catch {
      /* aborted or host unreachable */
    }
  })();
  return () => controller.abort();
}

export async function openPath(path: string): Promise<boolean> {
  if (isDesktop()) {
    await invoke('open_path', { path });
    return true;
  }
  return false;
}

export function newIdempotencyKey(prefix = 'kcw'): string {
  const rand = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  return `${prefix}-${rand}`;
}

// ---- D/E capabilities: tools, sub-agents, visualizations ----

export interface ToolDescriptor {
  name: string;
  description: string;
  source: string;
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

// ---- Connectors (one-click MCP connect) ----

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

// Fetch a live-artifact / viz HTML document WITH the bearer token (an <iframe
// src> can't send Authorization, so it would 401). Callers drop the result into
// a sandboxed <iframe srcDoc> instead of pointing src at a protected URL.
export async function fetchArtifactHtml(viewUrl: string): Promise<string> {
  await hostReady;
  const res = await fetch(viewUrl, { headers: authHeaders({ accept: 'text/html' }) });
  if (!res.ok) throw new Error(`artifact view returned ${res.status}`);
  return res.text();
}

export type VizKind = 'bar' | 'line' | 'pie' | 'doughnut' | 'mermaid' | 'table';
export interface VizSpec {
  title?: string;
  kind: VizKind;
  data?: unknown;
  options?: unknown;
  definition?: string;
}
export interface VizRenderResult {
  kind: string;
  html: string;
  persisted: boolean;
  id?: string;
  relativePath?: string;
  dataUrl?: string;
  viewUrl?: string;
}

export async function renderViz(spec: VizSpec, persist = true, trustedRoot?: string): Promise<VizRenderResult> {
  return postJson('/api/viz/render', { ...spec, persist, trustedRoot, idempotencyKey: newIdempotencyKey('viz') });
}

// Absolute URL for a saved live artifact page (open in an iframe or a new window).
export function liveArtifactUrl(viewUrl: string): string {
  return resolveUrl(viewUrl);
}

// ---- Artifacts catalog (.KimiCowork/artifacts) ----
export interface ArtifactItem {
  path: string;
  name: string;
  relativePath?: string;
  kind?: string;
  size?: number;
  modifiedAt?: string;
}

export async function listArtifacts(trustedRoot?: string, limit = 30): Promise<ArtifactItem[]> {
  const q = new URLSearchParams();
  if (trustedRoot) q.set('trustedRoot', trustedRoot);
  q.set('limit', String(limit));
  const res = await getJson<{ artifacts: ArtifactItem[] }>(`/api/artifacts?${q.toString()}`);
  return res.artifacts || [];
}

export interface ScheduleItem { id: string; name: string; kind?: string; cron?: string | null; cronHuman?: string | null; fireAt?: string | null; nextFireAt?: string | null; status?: string; runs?: number }

export async function listSchedules(): Promise<ScheduleItem[]> {
  const res = await getJson<{ schedules: ScheduleItem[] }>('/api/schedules');
  return res.schedules || [];
}

export async function cancelSchedule(id: string): Promise<boolean> {
  try {
    const res = await postJson<{ ok?: boolean; cancelled?: boolean }>(`/api/schedules/${encodeURIComponent(id)}/cancel`, { idempotencyKey: newIdempotencyKey('sched') });
    return Boolean(res.ok || res.cancelled);
  } catch { return false; }
}

export function artifactViewUrl(path: string, trustedRoot?: string): string {
  const q = new URLSearchParams();
  q.set('path', path);
  if (trustedRoot) q.set('trustedRoot', trustedRoot);
  return resolveUrl(`/api/artifacts/view?${q.toString()}`);
}

// ---- general chat + uploads + model info ----

export interface KimiInfo {
  configured: boolean;
  chatEnabled: boolean;
  planEnabled: boolean;
  model: string;
  baseUrl?: string;
  hasKey?: boolean;
}

export async function getKimiInfo(): Promise<KimiInfo> {
  return getJson('/api/kimi/info');
}

export interface SaveKimiConfigInput {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  clearKey?: boolean;
}

// Persist API settings on the host (.KimiCowork/config.json). The host never
// echoes the key back — only a `hasKey` flag — so the panel can show whether a
// key is set without ever exposing it.
export async function saveKimiConfig(input: SaveKimiConfigInput): Promise<KimiInfo> {
  return postJson<KimiInfo>('/api/kimi/config', { ...input });
}

// ---- auth (local login / register / session) ----

export interface AuthIdentity {
  userId: string;
  tenantId: string;
  username: string;
}

export async function register(username: string, password: string): Promise<AuthIdentity> {
  const res = await postJson<AuthIdentity & { token: string }>('/api/auth/register', { username, password });
  setAuthToken(res.token);
  return { userId: res.userId, tenantId: res.tenantId, username: res.username };
}

export async function login(username: string, password: string): Promise<AuthIdentity> {
  const res = await postJson<AuthIdentity & { token: string }>('/api/auth/login', { username, password });
  setAuthToken(res.token);
  return { userId: res.userId, tenantId: res.tenantId, username: res.username };
}

// Local "skip login": mint an isolated guest identity + token so the desktop
// still passes the host's auth gate (every /api call needs a token now).
export async function guestLogin(): Promise<AuthIdentity | null> {
  try {
    const res = await postJson<AuthIdentity & { token: string }>('/api/auth/guest', {});
    setAuthToken(res.token);
    return { userId: res.userId, tenantId: res.tenantId, username: res.username };
  } catch {
    return null;
  }
}

// Validate the stored token against the host. Returns null (and clears the
// token) when it is missing/expired, so the UI can fall back to the login gate.
export async function getMe(): Promise<AuthIdentity | null> {
  if (!getAuthToken()) return null;
  try {
    const res = await getJson<AuthIdentity>('/api/auth/me');
    return { userId: res.userId, tenantId: res.tenantId, username: res.username };
  } catch {
    setAuthToken(null);
    return null;
  }
}

export async function logout(): Promise<void> {
  try {
    await postJson('/api/auth/logout', {});
  } catch {
    /* best-effort: clear locally regardless */
  }
  setAuthToken(null);
}

// ---- account-scoped conversations (server-side history) ----

export interface StoredConversation {
  id: string;
  title: string;
  pinned?: boolean;
  messages: unknown[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  pinned?: boolean;
  messageCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

// Recent full conversation documents for the signed-in user (one startup call).
export async function listStoredConversations(limit = 50): Promise<StoredConversation[]> {
  try {
    const res = await getJson<{ conversations: StoredConversation[] }>(`/api/conversations?full=1&limit=${limit}`);
    return Array.isArray(res.conversations) ? res.conversations : [];
  } catch {
    return [];
  }
}

// Server-side title search with pagination (summaries only).
export async function searchStoredConversations(q: string, limit = 20, offset = 0): Promise<{ items: ConversationSummary[]; total: number }> {
  try {
    const res = await getJson<{ conversations: ConversationSummary[]; total?: number }>(
      `/api/conversations?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    );
    return { items: res.conversations || [], total: res.total || 0 };
  } catch {
    return { items: [], total: 0 };
  }
}

// Fetch one conversation's full document (used to lazily hydrate messages).
export async function getStoredConversation(id: string): Promise<StoredConversation | null> {
  try {
    const res = await getJson<{ conversation: StoredConversation }>(`/api/conversations/${encodeURIComponent(id)}`);
    return res.conversation || null;
  } catch {
    return null;
  }
}

export async function saveStoredConversation(
  id: string,
  data: { title?: string; pinned?: boolean; messages?: unknown[] },
): Promise<boolean> {
  try {
    await sendJsonMethod('PUT', `/api/conversations/${encodeURIComponent(id)}`, data);
    return true;
  } catch {
    return false;
  }
}

export async function deleteStoredConversation(id: string): Promise<boolean> {
  try {
    const res = await sendJsonMethod<{ deleted?: boolean }>('DELETE', `/api/conversations/${encodeURIComponent(id)}`);
    return Boolean(res.deleted);
  } catch {
    return false;
  }
}

// ---- file preview (images / markdown / text / pdf) ----

export interface FilePreviewResult {
  kind: 'image' | 'pdf' | 'markdown' | 'text' | 'other';
  mime: string;
  name: string;
  size: number;
  base64?: string;
  text?: string;
}

export async function previewFile(path: string, trustedRoot?: string): Promise<FilePreviewResult> {
  return postJson<FilePreviewResult>('/api/files/preview', { path, trustedRoot });
}

// ---- security / resilience self-check ----

export interface SelfCheckItem { id: string; status: 'pass' | 'warn'; detail: string }
export interface SelfCheckResult {
  service: string;
  time: string;
  security: { responseHeaders: string[]; cors: string; apiKey: { configured: boolean; hasKey: boolean }; bodyLimitBytes: number };
  resilience: {
    rateLimit: { enabled: boolean; ratePerSec?: number; burst?: number; tenants?: number };
    concurrency: { active: number; tenants: number; maxConcurrent: number; maxPerTenant: number };
    modelBreakers: Array<{ name: string; state: string; trips?: number }>;
    draining: boolean;
  };
  storage: { backend: string; postgres: boolean };
  checks: SelfCheckItem[];
}

export async function getSelfCheck(): Promise<SelfCheckResult> {
  return getJson('/api/selfcheck');
}

export interface ChatResult {
  ok: boolean;
  text: string;
  model?: string;
  runId?: string;
}

// General conversational turn (not a recipe). thinking/model are forwarded for
// forward-compat; the host currently ignores unknown fields.
export async function chat(
  prompt: string,
  opts: { trustedRoot?: string; model?: string; thinking?: string } = {},
): Promise<ChatResult> {
  return postJson('/api/kimi/chat', {
    prompt,
    trustedRoot: opts.trustedRoot,
    model: opts.model,
    thinking: opts.thinking,
  });
}

export interface UploadFile {
  relativePath: string;
  contentBase64: string;
  size?: number;
}

export async function importUploads(
  files: UploadFile[],
  trustedRoot?: string,
): Promise<{ imported?: Array<{ relativePath?: string; path?: string }> }> {
  return postJson('/api/uploads/import', { files, trustedRoot });
}

// Read a browser File into the base64 shape the host's /api/uploads/import wants.
export async function fileToUpload(file: File, dir = 'uploads'): Promise<UploadFile> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return { relativePath: `${dir}/${file.name}`, contentBase64: btoa(binary), size: file.size };
}

// ---- streaming chat (SSE over POST) ----

export interface ChatStreamHandlers {
  onToken?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onDone?: (full: { text: string; runId?: string; model?: string }) => void;
  onError?: (message: string) => void;
}

// POST /api/kimi/chat/stream returns text/event-stream; EventSource can't POST,
// so we read the body stream and parse SSE frames manually.
export async function chatStream(
  prompt: string,
  opts: { trustedRoot?: string; model?: string; thinking?: string } = {},
  handlers: ChatStreamHandlers = {},
): Promise<void> {
  await hostReady;
  const res = await fetch(resolveUrl('/api/kimi/chat/stream'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prompt, trustedRoot: opts.trustedRoot, model: opts.model, thinking: opts.thinking }),
  });
  if (!res.ok || !res.body) {
    let message = `stream failed (${res.status})`;
    try { const j = await res.json(); message = (j as { error?: string }).error || message; } catch { /* ignore */ }
    handlers.onError?.(message);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evMatch = /^event:\s*(.*)$/m.exec(frame);
      const dataMatch = /^data:\s*(.*)$/m.exec(frame);
      if (!evMatch) continue;
      const type = evMatch[1].trim();
      let data: { delta?: string; text?: string; runId?: string; model?: string; error?: string } = {};
      try { data = dataMatch ? JSON.parse(dataMatch[1]) : {}; } catch { /* ignore */ }
      if (type === 'token') handlers.onToken?.(data.delta || '');
      else if (type === 'reasoning') handlers.onReasoning?.(data.delta || '');
      else if (type === 'done') handlers.onDone?.({ text: data.text || '', runId: data.runId, model: data.model });
      else if (type === 'error') handlers.onError?.(data.error || 'stream error');
    }
  }
}

// ---- agentic chat (tool-calling loop over SSE) ----

export interface AgentStreamHandlers {
  onToken?: (delta: string) => void;
  onApprovalRequest?: (id: string, name: string, args: unknown) => void;
  onPlanProposed?: (id: string, plan: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCall?: (name: string, args: unknown) => void;
  onToolResult?: (name: string, status: string, result?: unknown) => void;
  onFileWritten?: (path: string) => void;
  onVerifyStart?: () => void;
  onQuestion?: (id: string, question: string, options: Array<{ label: string; description?: string }>) => void;
  onStart?: (runId: string) => void;
  onDone?: (full: { text: string; runId?: string; usage?: TokenUsage }) => void;
  onError?: (message: string) => void;
}

export interface TokenUsage { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }

// POST /api/agent/chat/stream — the model uses tools (read/write files, run
// code, fetch web) and we stream reasoning / tool_call / tool_result / token /
// done frames.
export async function agentChatStream(
  prompt: string,
  opts: { trustedRoot?: string; model?: string; thinking?: string; autoApprove?: boolean; planMode?: boolean; images?: string[] } = {},
  handlers: AgentStreamHandlers = {},
): Promise<void> {
  await hostReady;
  const res = await fetch(resolveUrl('/api/agent/chat/stream'), {
    method: 'POST',
    headers: authHeaders({ 'content-type': 'application/json' }),
    body: JSON.stringify({ prompt, trustedRoot: opts.trustedRoot, model: opts.model, thinking: opts.thinking, autoApprove: opts.autoApprove, planMode: opts.planMode, images: opts.images }),
  });
  if (!res.ok || !res.body) {
    let message = `agent stream failed (${res.status})`;
    try { const j = await res.json(); message = (j as { error?: string }).error || message; } catch { /* ignore */ }
    handlers.onError?.(message);
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const evMatch = /^event:\s*(.*)$/m.exec(frame);
      const dataMatch = /^data:\s*(.*)$/m.exec(frame);
      if (!evMatch) continue;
      const type = evMatch[1].trim();
      let data: { delta?: string; text?: string; runId?: string; id?: string; name?: string; status?: string; error?: string; args?: unknown; plan?: string; path?: string; question?: string; options?: Array<{ label: string; description?: string }>; usage?: TokenUsage; result?: unknown } = {};
      try { data = dataMatch ? JSON.parse(dataMatch[1]) : {}; } catch { /* ignore */ }
      if (type === 'start') handlers.onStart?.(data.runId || '');
      else if (type === 'token') handlers.onToken?.(data.delta || '');
      else if (type === 'reasoning') handlers.onReasoning?.(data.delta || '');
      else if (type === 'tool_call') handlers.onToolCall?.(data.name || '', data.args);
      else if (type === 'plan_proposed') handlers.onPlanProposed?.(data.id || '', data.plan || '');
      else if (type === 'approval_request') handlers.onApprovalRequest?.(data.id || '', data.name || '', data.args);
      else if (type === 'tool_result') handlers.onToolResult?.(data.name || '', data.status || 'succeeded', data.result);
      else if (type === 'file_written') handlers.onFileWritten?.(data.path || '');
      else if (type === 'verify_start') handlers.onVerifyStart?.();
      else if (type === 'question') handlers.onQuestion?.(data.id || '', data.question || '', Array.isArray(data.options) ? data.options : []);
      else if (type === 'done') handlers.onDone?.({ text: data.text || '', runId: data.runId, usage: data.usage });
      else if (type === 'cancelled') handlers.onDone?.({ text: data.text || '', runId: data.runId, usage: data.usage });
      else if (type === 'error') handlers.onError?.(data.error || 'agent error');
    }
  }
}

// Resolve a pending agent approval (Approve once / for-session / Reject).
export async function respondApproval(id: string, decision: 'once' | 'session' | 'reject'): Promise<boolean> {
  try {
    const res = await postJson<{ ok?: boolean }>(`/api/approvals/${encodeURIComponent(id)}`, { decision });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

// Answer a pending AskUserQuestion (the chosen option label) over the same channel.
export async function answerQuestion(id: string, answer: string): Promise<boolean> {
  try {
    const res = await postJson<{ ok?: boolean }>(`/api/approvals/${encodeURIComponent(id)}`, { answer });
    return Boolean(res.ok);
  } catch {
    return false;
  }
}

// Cancel a running agent turn (the Claude Cowork stop button).
export async function cancelRun(runId: string): Promise<boolean> {
  if (!runId) return false;
  try {
    const res = await postJson<{ cancelled?: boolean }>(`/api/runs/${encodeURIComponent(runId)}/cancel`, {});
    return Boolean(res.cancelled);
  } catch {
    return false;
  }
}
