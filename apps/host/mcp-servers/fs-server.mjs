#!/usr/bin/env node
// A tiny, dependency-free filesystem MCP server (stdio transport).
//
// Usage (as an MCP connector): node fs-server.mjs <root>
//   - all paths are jailed inside <root> (default: cwd)
//   - tools: list_dir, read_text, stat
//
// Speaks newline-delimited JSON-RPC 2.0, matching the host's StdioTransport.
// This is intentionally self-contained (no imports from the host) so it can be
// distributed and run as a standalone connector.
import fs from 'node:fs';
import path from 'node:path';

function realpath(p) {
  return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
}

function normalizeForCompare(p) {
  const normalized = path.resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

const ROOT = realpath(path.resolve(process.argv[2] || process.cwd()));
const MAX_READ = 256 * 1024;

function isInsideRoot(candidate) {
  const rootNorm = normalizeForCompare(ROOT);
  const targetNorm = normalizeForCompare(candidate);
  const rootWithSep = rootNorm.endsWith('/') ? rootNorm : `${rootNorm}/`;
  return targetNorm === rootNorm || targetNorm.startsWith(rootWithSep);
}

function escapeError(target) {
  const err = new Error(`path escapes root: ${target}`);
  err.code = -32001;
  return err;
}

function inside(target) {
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

const TOOLS = [
  { name: 'list_dir', description: '列出目录条目 (name + type), jail 在 root 内', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'read_text', description: '读取一个文本文件 (最多 256KB)', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'stat', description: '返回文件/目录的大小、类型、修改时间', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

function callTool(name, args = {}) {
  if (name === 'list_dir') {
    const dir = inside(args.path);
    const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
    }));
    return { content: [{ type: 'text', text: JSON.stringify(entries) }] };
  }
  if (name === 'read_text') {
    const file = inside(args.path);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error('not a file');
    if (stat.size > MAX_READ) throw new Error(`file too large (max ${MAX_READ} bytes)`);
    return { content: [{ type: 'text', text: fs.readFileSync(file, 'utf8') }] };
  }
  if (name === 'stat') {
    const target = inside(args.path);
    const s = fs.statSync(target);
    return { content: [{ type: 'text', text: JSON.stringify({ size: s.size, type: s.isDirectory() ? 'dir' : 'file', mtime: s.mtime.toISOString() }) }] };
  }
  const err = new Error(`unknown tool: ${name}`);
  err.code = -32601;
  throw err;
}

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}
function replyError(id, message, code = -32000) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);
}

function handle(msg) {
  if (msg.id == null) return; // notification
  if (msg.method === 'initialize') {
    reply(msg.id, { serverInfo: { name: 'fs-server', version: '0.1.0', root: ROOT }, capabilities: { tools: {} } });
    return;
  }
  if (msg.method === 'tools/list') {
    reply(msg.id, { tools: TOOLS });
    return;
  }
  if (msg.method === 'tools/call') {
    try {
      reply(msg.id, callTool(msg.params?.name, msg.params?.arguments || {}));
    } catch (err) {
      replyError(msg.id, err.message, err.code || -32000);
    }
    return;
  }
  replyError(msg.id, 'method not found', -32601);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
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
