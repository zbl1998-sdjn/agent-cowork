import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createArtifactFileOperationGuards,
  createArtifactRollbackGuards,
} from '../src/artifacts/artifact-owner-write.js';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { createServer } from '../src/server.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import {
  previewFileOperations,
  rollbackFileOperations,
} from '../src/workspace/file-operations.js';
import { bind, close, jsonRequest, tempRoot } from './helpers/host-http.js';
import type { AgentTool } from '../src/kimi/agent-tools.js';

const TENANT = 'tenant_shared';
const ALICE_OWNER = Object.freeze({ tenantId: TENANT, userId: 'alice' });
const BOB_OWNER = Object.freeze({ tenantId: TENANT, userId: 'bob' });
const ALICE = Object.freeze({ authorization: 'Bearer alice-token' });
const BOB = Object.freeze({ authorization: 'Bearer bob-token' });

function siblingAuthStore() {
  return {
    resolveToken(token: string) {
      if (token === 'alice-token') return ALICE_OWNER;
      if (token === 'bob-token') return BOB_OWNER;
      return null;
    },
  };
}

function isNotFound(error: unknown): boolean {
  return (error as { statusCode?: unknown }).statusCode === 404;
}

function handler(tools: AgentTool[], name: string): NonNullable<AgentTool['handler']> {
  const selected = tools.find((tool) => tool.name === name)?.handler;
  assert.equal(typeof selected, 'function', `${name} should be registered`);
  return selected as NonNullable<AgentTool['handler']>;
}

function seedWorkspace(root: string) {
  const indexRoot = path.join(root, '.AgentCowork', 'index');
  const runRoot = path.join(root, '.AgentCowork', 'runs');
  const githubRoot = path.join(root, '.github', 'workflows');
  fs.mkdirSync(indexRoot, { recursive: true });
  fs.mkdirSync(runRoot, { recursive: true });
  fs.mkdirSync(githubRoot, { recursive: true });
  const indexPath = path.join(indexRoot, 'index.jsonl');
  const runPath = path.join(runRoot, 'private.txt');
  const publicPath = path.join(githubRoot, 'ci.txt');
  fs.writeFileSync(indexPath, 'INTERNAL_INDEX_ONLY', 'utf8');
  fs.writeFileSync(runPath, 'INTERNAL_RUN_ONLY', 'utf8');
  fs.writeFileSync(publicPath, 'PUBLIC_GITHUB', 'utf8');
  return { indexRoot, indexPath, runPath, publicPath };
}

test('native and builtin file tools deny internal metadata for every user without blocking .github', async () => {
  const root = tempRoot('kcw-internal-tools-');
  const seeded = seedWorkspace(root);
  const internalAlias = path.join(seeded.indexRoot, 'public-alias');
  const artifactAlias = path.join(root, '.AgentCowork', 'artifacts', 'public-alias');
  fs.mkdirSync(path.dirname(artifactAlias), { recursive: true });
  fs.symlinkSync(path.join(root, '.github'), internalAlias, 'junction');
  fs.symlinkSync(path.join(root, '.github'), artifactAlias, 'junction');
  const aliceTools = createAgentTools({ trustedRoot: root, context: ALICE_OWNER });
  const bobTools = createAgentTools({ trustedRoot: root, context: BOB_OWNER });

  for (const tools of [aliceTools, bobTools]) {
    await assert.rejects(() => handler(tools, 'Read')({ path: seeded.indexPath }), isNotFound);
    await assert.rejects(() => handler(tools, 'Edit')({
      path: seeded.runPath,
      old_string: 'INTERNAL',
      new_string: 'STOLEN',
    }), isNotFound);
    await assert.rejects(() => handler(tools, 'Write')({
      path: path.join(seeded.indexRoot, 'injected.jsonl'),
      content: 'INJECTED',
    }), isNotFound);
  }
  assert.equal(fs.readFileSync(seeded.runPath, 'utf8'), 'INTERNAL_RUN_ONLY');
  assert.equal(fs.existsSync(path.join(seeded.indexRoot, 'injected.jsonl')), false);
  for (const alias of [internalAlias, artifactAlias]) {
    await assert.rejects(() => handler(aliceTools, 'Edit')({
      path: path.join(alias, 'workflows', 'ci.txt'),
      old_string: 'PUBLIC',
      new_string: 'STOLEN',
    }), isNotFound);
  }
  assert.equal(fs.readFileSync(seeded.publicPath, 'utf8'), 'PUBLIC_GITHUB');

  await handler(aliceTools, 'Edit')({
    path: seeded.publicPath,
    old_string: 'PUBLIC',
    new_string: 'VISIBLE',
  });
  assert.equal(fs.readFileSync(seeded.publicPath, 'utf8'), 'VISIBLE_GITHUB');
  await assert.rejects(() => handler(aliceTools, 'PlanFileOrganization')({
    files: [seeded.publicPath],
    mode: 'byExtension',
    targetDir: '.AgentCowork/index',
  }), isNotFound);

  const glob = await handler(aliceTools, 'Glob')({ pattern: '**/*' }) as { matches?: unknown };
  assert.doesNotMatch(JSON.stringify(glob.matches), /INTERNAL|index\.jsonl|private\.txt/);

  const profile = createBuiltinTools({ sandbox: null }).find((tool) => tool.name === 'data.profile');
  assert.ok(profile);
  fs.writeFileSync(path.join(seeded.indexRoot, 'private.csv'), 'name,value\nINTERNAL,1\n', 'utf8');
  await assert.rejects(
    () => Promise.resolve(profile.handler(
      { path: path.join(seeded.indexRoot, 'private.csv') },
      { trustedRoot: root, context: ALICE_OWNER },
    )),
    isNotFound,
  );

  assert.throws(
    () => createAgentTools({ trustedRoot: seeded.indexRoot, context: ALICE_OWNER }),
    isNotFound,
    'an internal directory must not be reinterpreted as a new external workspace root',
  );
  assert.throws(
    () => createAgentTools({ trustedRoot: internalAlias, context: ALICE_OWNER }),
    isNotFound,
    'an internal junction must not be reinterpreted as a public workspace root',
  );
});

test('workspace HTTP reads, bundles, attachments, uploads, and root substitution hide internal metadata', async () => {
  const root = tempRoot('kcw-internal-http-');
  const seeded = seedWorkspace(root);
  const publicAlias = path.join(seeded.indexRoot, 'public-alias');
  fs.symlinkSync(path.join(root, '.github'), publicAlias, 'junction');
  const server = createServer({
    trustedRoot: root,
    enableScheduler: false,
    requireAuth: true,
    authStore: siblingAuthStore(),
  });
  const base = await bind(server);
  try {
    for (const headers of [ALICE, BOB]) {
      const direct = await jsonRequest(base, '/api/files/read', {
        method: 'POST', headers, body: { trustedRoot: root, path: seeded.indexPath },
      });
      assert.equal(direct.status, 404);
      assert.doesNotMatch(JSON.stringify(direct.body), /INTERNAL_INDEX_ONLY/);

      const substituted = await jsonRequest(base, '/api/files/read', {
        method: 'POST', headers, body: { trustedRoot: seeded.indexRoot, path: 'index.jsonl' },
      });
      assert.equal(substituted.status, 404);

      const junctionRoot = await jsonRequest(base, '/api/files/read', {
        method: 'POST',
        headers,
        body: { trustedRoot: publicAlias, path: 'workflows/ci.txt' },
      });
      assert.equal(junctionRoot.status, 404);

      const bundle = await jsonRequest(base, '/api/context/bundle', {
        method: 'POST', headers, body: { trustedRoot: root, paths: [seeded.indexPath] },
      });
      assert.deepEqual(bundle.body.files, []);
      assert.doesNotMatch(JSON.stringify(bundle.body), /INTERNAL_INDEX_ONLY/);

      const attachment = await jsonRequest(base, '/api/attachments/context', {
        method: 'POST', headers, body: { trustedRoot: root, files: ['.AgentCowork/runs/private.txt'] },
      });
      assert.deepEqual(attachment.body.items, []);
      assert.doesNotMatch(JSON.stringify(attachment.body), /INTERNAL_RUN_ONLY/);

      const search = await jsonRequest(base, '/api/workspace/search', {
        method: 'POST',
        headers,
        body: { trustedRoot: seeded.indexRoot, query: 'INTERNAL_INDEX_ONLY' },
      });
      assert.equal(search.status, 404);
      assert.doesNotMatch(JSON.stringify(search.body), /INTERNAL_INDEX_ONLY/);

      const fileOp = await jsonRequest(base, '/api/file-ops/preview', {
        method: 'POST',
        headers,
        body: {
          trustedRoot: root,
          operations: [{ type: 'write', path: seeded.indexPath, content: 'OVERWRITE', overwrite: true }],
        },
      });
      assert.equal(fileOp.status, 404);
    }

    const publicTree = await jsonRequest(base, '/api/files/tree', {
      method: 'POST',
      headers: ALICE,
      body: { root: path.join(root, '.github') },
    });
    assert.equal(publicTree.status, 200);
    assert.match(JSON.stringify(publicTree.body), /ci\.txt/);

    const upload = await jsonRequest(base, '/api/uploads/import', {
      method: 'POST',
      headers: ALICE,
      body: {
        trustedRoot: seeded.indexRoot,
        files: [{ relativePath: 'injected.txt', contentBase64: Buffer.from('INJECTED').toString('base64'), size: 8 }],
      },
    });
    assert.equal(upload.status, 404);
    assert.equal(fs.existsSync(path.join(seeded.indexRoot, 'Agent_Cowork上传')), false);
  } finally {
    await close(server);
  }
});

test('file-operation preview denies internal writes and moves before issuing approval', () => {
  const root = tempRoot('kcw-internal-file-ops-');
  const seeded = seedWorkspace(root);
  const publicSource = path.join(root, 'public.txt');
  fs.writeFileSync(publicSource, 'PUBLIC', 'utf8');

  assert.throws(() => previewFileOperations([
    { type: 'write', path: seeded.indexPath, content: 'OVERWRITE', overwrite: true },
  ], { trustedRoot: root }), isNotFound);
  assert.throws(() => previewFileOperations([
    { type: 'move', from: publicSource, to: path.join(seeded.indexRoot, 'moved.txt') },
  ], { trustedRoot: root }), isNotFound);
  assert.throws(() => previewFileOperations([
    { type: 'move', from: seeded.runPath, to: path.join(root, 'stolen.txt') },
  ], { trustedRoot: root }), isNotFound);
  assert.equal(fs.readFileSync(seeded.indexPath, 'utf8'), 'INTERNAL_INDEX_ONLY');
  assert.equal(fs.existsSync(publicSource), true);

  const guards = createArtifactFileOperationGuards(root, ALICE_OWNER);
  const publicPreview = previewFileOperations([
    { type: 'write', path: path.join(root, '.github', 'visible.txt'), content: 'VISIBLE' },
  ], { trustedRoot: root, ...guards });
  assert.equal(publicPreview.operations.length, 1);
  assert.throws(
    () => createArtifactFileOperationGuards(seeded.indexRoot, ALICE_OWNER),
    isNotFound,
  );
});

test('rollback guards reject internal delete, restore, and rename before filesystem mutation', () => {
  const root = tempRoot('kcw-internal-rollback-');
  const seeded = seedWorkspace(root);
  const backup = path.join(root, 'backup.txt');
  fs.writeFileSync(backup, 'BACKUP', 'utf8');

  assert.throws(() => rollbackFileOperations([
    { type: 'delete-created-file', path: seeded.indexPath },
  ], { trustedRoot: root }), isNotFound);
  assert.equal(fs.readFileSync(seeded.indexPath, 'utf8'), 'INTERNAL_INDEX_ONLY');

  assert.throws(() => rollbackFileOperations([
    { type: 'restore-backup', path: seeded.runPath, backupPath: backup },
  ], { trustedRoot: root }), isNotFound);
  assert.equal(fs.readFileSync(seeded.runPath, 'utf8'), 'INTERNAL_RUN_ONLY');

  assert.throws(() => rollbackFileOperations([
    { type: 'rename-back', from: seeded.runPath, to: path.join(root, 'stolen.txt') },
  ], { trustedRoot: root }), isNotFound);
  assert.equal(fs.existsSync(seeded.runPath), true);
  assert.equal(fs.existsSync(path.join(root, 'stolen.txt')), false);
  assert.throws(
    () => createArtifactRollbackGuards(seeded.indexRoot, ALICE_OWNER),
    isNotFound,
  );
});
