#!/usr/bin/env node
// A tiny, dependency-free filesystem MCP server (stdio transport).
//
// Usage (as an MCP connector):
//   node scripts/run-host-node.mjs apps/host/mcp-servers/fs-server.ts <root>
//   - all paths are jailed inside <root> (default: cwd)
//   - tools: list_dir, read_text, stat
//
// Speaks newline-delimited JSON-RPC 2.0, matching the host's StdioTransport.
// This is intentionally self-contained (no imports from the host) so it can be
// distributed and run as a standalone connector.
import fs from 'node:fs';
import path from 'node:path';

type JsonRpcId = string | number | null;
type JsonRpcParams = { name?: unknown; arguments?: unknown };
type JsonRpcRequest = { id?: JsonRpcId; method?: string; params?: JsonRpcParams };
type McpError = Error & { code?: number };
type ToolArgs = { path?: string };
type ToolResult = { content: { type: 'text'; text: string }[] };
type ToolDescriptor = {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: { path: { type: 'string' } };
    required?: string[];
  };
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function isJsonRpcId(value: unknown): value is JsonRpcId {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

function requestFrom(value: unknown): JsonRpcRequest | null {
  if (!isRecord(value)) return null;

  const request: JsonRpcRequest = {};
  if ('id' in value) request.id = isJsonRpcId(value.id) ? value.id : null;
  if (typeof value.method === 'string') request.method = value.method;
  if (isRecord(value.params)) {
    const params: JsonRpcParams = {};
    if ('name' in value.params) params.name = value.params.name;
    if ('arguments' in value.params) params.arguments = value.params.arguments;
    request.params = params;
  }
  return request;
}

function toolArgsFrom(value: unknown): ToolArgs {
  if (!isRecord(value)) return {};
  return typeof value.path === 'string' ? { path: value.path } : {};
}

function mcpError(error: unknown): McpError {
  return error instanceof Error ? (error as McpError) : (new Error(String(error)) as McpError);
}

function realpath(inputPath: string): string {
  return fs.realpathSync.native ? fs.realpathSync.native(inputPath) : fs.realpathSync(inputPath);
}

function normalizeForCompare(inputPath: string): string {
  const normalized = path.resolve(inputPath).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

const ROOT = realpath(path.resolve(process.argv[2] || process.cwd()));
const MAX_READ = 256 * 1024;
const IGNORED_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'coverage']);
const SENSITIVE_SEGMENTS = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.kube',
  '.ssh',
  '.env',
  '.kimi',
  'appdata',
  'credentials',
]);
const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);
const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);

function isInsideRoot(candidate: string): boolean {
  const rootNorm = normalizeForCompare(ROOT);
  const targetNorm = normalizeForCompare(candidate);
  const rootWithSep = rootNorm.endsWith('/') ? rootNorm : `${rootNorm}/`;
  return targetNorm === rootNorm || targetNorm.startsWith(rootWithSep);
}

function escapeError(target: string | undefined): McpError {
  const err = new Error(`path escapes root: ${target}`) as McpError;
  err.code = -32001;
  return err;
}

function segmentsBelowRoot(candidate: string): string[] {
  const relative = path.relative(ROOT, candidate).replace(/\\/g, '/');
  if (!relative || relative === '.') return [];
  return relative.split('/').filter(Boolean);
}

function isBlockedWorkspacePath(candidate: string): boolean {
  const base = path.basename(candidate).toLowerCase();
  const ext = path.extname(base).toLowerCase();
  if (base.startsWith('id_rsa') || SENSITIVE_FILENAMES.has(base) || SENSITIVE_EXTENSIONS.has(ext)) {
    return true;
  }
  for (const segment of segmentsBelowRoot(candidate)) {
    const lower = segment.toLowerCase();
    if (lower.startsWith('.') || IGNORED_SEGMENTS.has(lower) || SENSITIVE_SEGMENTS.has(lower) || lower.startsWith('.env')) {
      return true;
    }
  }
  return false;
}

function assertReadable(candidate: string, original?: string): string {
  if (isBlockedWorkspacePath(candidate)) {
    const err = new Error(`workspace ignored or sensitive path blocked: ${original || candidate}`) as McpError;
    err.code = -32002;
    throw err;
  }
  return candidate;
}

function inside(target?: string): string {
  const resolved = path.resolve(ROOT, target || '.');
  if (!isInsideRoot(resolved)) {
    throw escapeError(target);
  }
  const realTarget = realpath(resolved);
  if (isInsideRoot(realTarget)) {
    return realTarget;
  }
  throw escapeError(target);
}

const TOOLS: ToolDescriptor[] = [
  {
    name: 'list_dir',
    description: '列出目录条目 (name + type), jail 在 root 内',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
  },
  {
    name: 'read_text',
    description: '读取一个文本文件 (最多 256KB)',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
  {
    name: 'stat',
    description: '返回文件/目录的大小、类型、修改时间',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

function callTool(name: unknown, rawArgs: unknown = {}): ToolResult {
  const args = toolArgsFrom(rawArgs);
  if (name === 'list_dir') {
    const dir = assertReadable(inside(args.path), args.path);
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => !isBlockedWorkspacePath(path.join(dir, e.name)))
      .map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
      }));
    return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
  }
  if (name === 'read_text') {
    const file = assertReadable(inside(args.path), args.path);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    if (stat.size > MAX_READ) throw new Error(`file too large (max ${MAX_READ} bytes)`);
    return { content: [{ type: 'text', text: fs.readFileSync(file, 'utf8') }] };
  }
  if (name === 'stat') {
    const target = assertReadable(inside(args.path), args.path);
    const s = fs.statSync(target);
    return { content: [{ type: 'text', text: JSON.stringify({ size: s.size, type: s.isDirectory() ? 'dir' : 'file', mtime: s.mtime.toISOString() }) }] };
  }
  const err = new Error(`unknown tool: ${name}`);
  (err as McpError).code = -32601;
  throw err;
}

function reply(id: string | number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

function replyError(id: string | number, message: string, code = -32000): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function handle(value: unknown): void {
  const msg = requestFrom(value);
  if (!msg) return;
  const id = msg.id;
  if (id == null) return; // notification
  if (msg.method === 'initialize') {
    reply(id, { serverInfo: { name: 'fs-server', version: '0.1.0', root: ROOT }, capabilities: { tools: {} } });
    return;
  }
  if (msg.method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }
  if (msg.method === 'tools/call') {
    try {
      reply(id, callTool(msg.params?.name, msg.params?.arguments ?? {}));
    } catch (err) {
      const error = mcpError(err);
      replyError(id, error.message, typeof error.code === 'number' ? error.code : -32000);
    }
    return;
  }
  replyError(id, 'method not found', -32601);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  let i = buffer.indexOf('\n');
  while (i >= 0) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (line) {
      try { handle(JSON.parse(line)); } catch { /* ignore malformed line */ }
    }
    i = buffer.indexOf('\n');
  }
});
