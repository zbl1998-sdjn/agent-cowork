import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { connectMcpServers, closeMcpClients } from '../src/mcp/connect.js';
import { createToolRegistry } from '../src/tools/tool-registry.js';

const FS_SERVER = fileURLToPath(new URL('../mcp-servers/fs-server.mjs', import.meta.url));

function seedRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-fsmcp-'));
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello world', 'utf8');
  fs.mkdirSync(path.join(root, 'sub'));
  return root;
}

test('fs-server exposes jailed filesystem tools over a real subprocess', async () => {
  const root = seedRoot();
  const registry = createToolRegistry();
  const out = await connectMcpServers({
    registry,
    servers: [{ name: 'fs', command: process.execPath, args: [FS_SERVER, root] }],
  });
  try {
    assert.equal(out.toolCount, 3);
    assert.equal(registry.has('mcp__fs__list_dir'), true);
    assert.equal(registry.has('mcp__fs__read_text'), true);

    const listed = await registry.call('mcp__fs__list_dir', {});
    const entries = JSON.parse(listed.content[0].text);
    const names = entries.map((e) => e.name).sort();
    assert.deepEqual(names, ['a.txt', 'sub']);

    const read = await registry.call('mcp__fs__read_text', { path: 'a.txt' });
    assert.equal(read.content[0].text, 'hello world');

    const stat = await registry.call('mcp__fs__stat', { path: 'sub' });
    assert.equal(JSON.parse(stat.content[0].text).type, 'dir');
  } finally {
    closeMcpClients(out.clients);
  }
});

test('fs-server rejects path traversal outside the root', async () => {
  const root = seedRoot();
  const registry = createToolRegistry();
  const out = await connectMcpServers({
    registry,
    servers: [{ name: 'fs', command: process.execPath, args: [FS_SERVER, root] }],
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
    servers: [{ name: 'fs', command: process.execPath, args: [FS_SERVER, root] }],
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
