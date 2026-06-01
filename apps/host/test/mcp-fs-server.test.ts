import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { connectMcpServers, closeMcpClients } from '../src/mcp/connect.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';
import { itemAt, toolCallResultSchema } from './helpers/mcp.js';

const FS_SERVER = fileURLToPath(new URL('../mcp-servers/fs-server.mjs', import.meta.url).href);

const fsEntrySchema = z.object({
  name: z.string(),
  type: z.enum(['dir', 'file', 'other']),
});

const fsStatSchema = z.object({
  type: z.enum(['dir', 'file']),
}).loose();

function seedRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-fsmcp-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello world', 'utf8');
  fs.writeFileSync(path.join(root, '.npmrc'), 'token=secret', 'utf8');
  fs.mkdirSync(path.join(root, 'sub'));
  return root;
}

function nodeExecPath(): string {
  const execPath = process.execPath;
  assert.ok(execPath, 'process.execPath should be available for MCP subprocess tests');
  return execPath;
}

function textContent(value: unknown, label: string): string {
  const result = toolCallResultSchema.parse(value);
  return itemAt(result.content, 0, label).text;
}

test('fs-server exposes jailed filesystem tools over a real subprocess', async () => {
  const root = seedRoot();
  const registry = createToolRegistry();
  const out = await connectMcpServers({
    registry,
    servers: [{ name: 'fs', command: nodeExecPath(), args: [FS_SERVER, root] }],
  });
  try {
    assert.equal(out.toolCount, 3);
    assert.equal(registry.has('mcp__fs__list_dir'), true);
    assert.equal(registry.has('mcp__fs__read_text'), true);

    const entries = z.array(fsEntrySchema).parse(JSON.parse(textContent(await registry.call('mcp__fs__list_dir', {}), 'list_dir content')));
    const names = entries.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['a.txt', 'sub']);

    assert.equal(textContent(await registry.call('mcp__fs__read_text', { path: 'a.txt' }), 'read_text content'), 'hello world');

    const stat = fsStatSchema.parse(JSON.parse(textContent(await registry.call('mcp__fs__stat', { path: 'sub' }), 'stat content')));
    assert.equal(stat.type, 'dir');
  } finally {
    closeMcpClients(out.clients);
  }
});

test('fs-server blocks hidden and credential-like files inside the root', async () => {
  const root = seedRoot();
  const registry = createToolRegistry();
  const out = await connectMcpServers({
    registry,
    servers: [{ name: 'fs', command: nodeExecPath(), args: [FS_SERVER, root] }],
  });
  try {
    await assert.rejects(
      () => registry.call('mcp__fs__read_text', { path: '.npmrc' }),
      /sensitive path blocked/,
    );
    await assert.rejects(
      () => registry.call('mcp__fs__stat', { path: '.npmrc' }),
      /sensitive path blocked/,
    );
  } finally {
    closeMcpClients(out.clients);
  }
});

test('fs-server rejects path traversal outside the root', async () => {
  const root = seedRoot();
  const registry = createToolRegistry();
  const out = await connectMcpServers({
    registry,
    servers: [{ name: 'fs', command: nodeExecPath(), args: [FS_SERVER, root] }],
  });
  try {
    await assert.rejects(
      () => registry.call('mcp__fs__read_text', { path: '../../etc/passwd' }),
      /escapes root/,
    );
  } finally {
    closeMcpClients(out.clients);
  }
});

test('fs-server rejects symlink or junction escapes outside the root', async (t) => {
  const root = seedRoot();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-fsmcp-outside-'));
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret', 'utf8');
  const link = path.join(root, 'escape');
  try {
    fs.symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('cannot create directory link on this filesystem');
    return;
  }

  const registry = createToolRegistry();
  const out = await connectMcpServers({
    registry,
    servers: [{ name: 'fs', command: nodeExecPath(), args: [FS_SERVER, root] }],
  });
  try {
    await assert.rejects(
      () => registry.call('mcp__fs__read_text', { path: 'escape/secret.txt' }),
      /escapes root/,
    );
    await assert.rejects(
      () => registry.call('mcp__fs__list_dir', { path: 'escape' }),
      /escapes root/,
    );
  } finally {
    closeMcpClients(out.clients);
  }
});
