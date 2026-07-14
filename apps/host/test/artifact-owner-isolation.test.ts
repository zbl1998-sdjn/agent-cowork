import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  artifactOwnerClaimPath,
  ensureArtifactOwnerClaim,
} from '../src/artifacts/artifact-owner.js';
import { renameArtifact } from '../src/artifacts/artifact-catalog.js';
import { buildLiveArtifact } from '../src/artifacts/live-artifact.js';
import { createAgentTools } from '../src/engine/agent-tools.js';
import { createServer } from '../src/server.js';
import { createBuiltinTools } from '../src/tools/builtin-tools.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';
import { samePathReal } from './helpers/path-swap.js';

const TENANT = 'tenant_shared';
const ALICE = { authorization: 'Bearer alice-token' };
const BOB = { authorization: 'Bearer bob-token' };

function siblingAuthStore() {
  return {
    resolveToken(token: string) {
      if (token === 'alice-token') return { tenantId: TENANT, userId: 'alice' };
      if (token === 'bob-token') return { tenantId: TENANT, userId: 'bob' };
      return null;
    },
  };
}

async function persistLiveArtifact(base: string, body: Record<string, unknown>, key: string): Promise<Record<string, unknown>> {
  const preview = await jsonRequest(base, '/api/viz/render/preview', {
    method: 'POST',
    headers: ALICE,
    body,
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const approvedBody = {
    ...body,
    id: stringField(preview.body, 'id'),
    fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
  };
  const rendered = await jsonRequest(base, '/api/viz/render', {
    method: 'POST',
    headers: { ...ALICE, 'idempotency-key': key },
    body: approvedBody,
  });
  assert.equal(rendered.status, 200);
  return rendered.body;
}

async function writeStaticArtifact(base: string, trustedRoot: string, artifactPath: string): Promise<void> {
  const operations = [{ type: 'write', path: artifactPath, content: '# Alice only' }];
  const preview = await jsonRequest(base, '/api/file-ops/preview', {
    method: 'POST',
    headers: ALICE,
    body: { trustedRoot, operations },
  });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  const applied = await jsonRequest(base, '/api/file-ops/apply', {
    method: 'POST',
    headers: { ...ALICE, 'idempotency-key': 'alice-static-write' },
    body: {
      trustedRoot,
      operations,
      fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId'),
    },
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
}

test('live artifact routes hide an artifact from a sibling user before connector refresh side effects', async () => {
  const trustedRoot = tempRoot('kcw-art-owner-');
  let connectorCalls = 0;
  const toolRegistry = {
    registerMcpClient: () => 0,
    descriptor: () => ({ source: 'mcp:demo', name: 'mcp__demo__private', risk: 'low', mutating: false }),
    call: () => {
      connectorCalls += 1;
      return { viz: { kind: 'table', data: { columns: ['secret'], rows: [['alice-only']] } } };
    },
  };
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: true,
    authStore: siblingAuthStore(),
    toolRegistry,
  });
  const base = await bind(server);
  try {
    const id = 'viz_alice_private';
    const rendered = await persistLiveArtifact(base, {
      id,
      title: 'Alice private',
      kind: 'table',
      data: { columns: ['secret'], rows: [['initial']] },
      dataSource: { type: 'connector-tool', tool: 'mcp__demo__private', args: {} },
    }, 'alice-live-owner');
    assert.equal(rendered.id, id);

    const aliceLive = await fetch(`${base}/api/artifacts/live/${id}`, { headers: ALICE });
    assert.equal(aliceLive.status, 200);

    const bobLive = await fetch(`${base}/api/artifacts/live/${id}`, { headers: BOB });
    assert.equal(bobLive.status, 404);

    const bobData = await jsonRequest(base, `/api/artifacts/data/${id}`, { headers: BOB });
    assert.equal(bobData.status, 404);
    assert.equal(connectorCalls, 0, 'owner denial must happen before descriptor/call side effects');

    const bobList = await jsonRequest(base, '/api/artifacts', { headers: BOB });
    assert.deepEqual(bobList.body.artifacts, []);

    const htmlPath = path.join(trustedRoot, '.AgentCowork', 'artifacts', `${id}.html`);
    const bobView = await fetch(`${base}/api/artifacts/view?path=${encodeURIComponent(htmlPath)}`, { headers: BOB });
    assert.equal(bobView.status, 404);

    const bobRename = await jsonRequest(base, '/api/artifacts/rename', {
      method: 'POST',
      headers: { ...BOB, 'idempotency-key': 'bob-live-rename' },
      body: { path: htmlPath, newName: 'stolen.html' },
    });
    assert.equal(bobRename.status, 404);
    assert.equal(fs.existsSync(htmlPath), true);
    assert.equal(fs.existsSync(path.join(path.dirname(htmlPath), 'stolen.html')), false);
  } finally {
    await close(server);
  }
});

test('static artifact writes create hash-only owner claims and block sibling reads and generic renames', async () => {
  const trustedRoot = tempRoot('kcw-static-art-owner-');
  const artifactPath = path.join(trustedRoot, '.AgentCowork', 'artifacts', 'alice-private.md');
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: true,
    authStore: siblingAuthStore(),
  });
  const base = await bind(server);
  try {
    await writeStaticArtifact(base, trustedRoot, artifactPath);
    assert.equal(fs.readFileSync(artifactPath, 'utf8'), '# Alice only');

    const claimRoot = path.join(trustedRoot, '.AgentCowork', 'artifacts', '.owners');
    const claimFiles = fs.readdirSync(claimRoot);
    assert.equal(claimFiles.length, 1);
    const claimText = fs.readFileSync(path.join(claimRoot, claimFiles[0] || ''), 'utf8');
    const claim = JSON.parse(claimText) as Record<string, unknown>;
    assert.deepEqual(Object.keys(claim).sort(), ['ownerSha256', 'relativePathSha256', 'version']);
    assert.doesNotMatch(claimText, /tenant_shared|alice|bob/);

    const aliceList = await jsonRequest(base, '/api/artifacts', { headers: ALICE });
    assert.equal((aliceList.body.artifacts as unknown[]).length, 1);
    const bobList = await jsonRequest(base, '/api/artifacts', { headers: BOB });
    assert.deepEqual(bobList.body.artifacts, []);

    const bobView = await fetch(
      `${base}/api/artifacts/view?path=${encodeURIComponent(artifactPath)}`,
      { headers: BOB },
    );
    assert.equal(bobView.status, 404);

    const bobTree = await jsonRequest(base, '/api/files/tree', {
      method: 'POST',
      headers: BOB,
      body: { root: trustedRoot },
    });
    assert.equal(bobTree.status, 200);
    assert.equal(JSON.stringify(bobTree.body).includes('alice-private.md'), false);
    assert.equal(JSON.stringify(bobTree.body).includes('.owners'), false);

    for (const endpoint of ['/api/files/read', '/api/files/preview', '/api/files/extract']) {
      const denied = await jsonRequest(base, endpoint, {
        method: 'POST',
        headers: BOB,
        body: { trustedRoot, path: artifactPath },
      });
      assert.equal(denied.status, 404, endpoint);
    }

    const bobSearch = await jsonRequest(base, '/api/files/search', {
      method: 'POST',
      headers: BOB,
      body: { trustedRoot, query: 'Alice only', includeContent: true },
    });
    assert.deepEqual(bobSearch.body.results, []);

    const bobBundle = await jsonRequest(base, '/api/context/bundle', {
      method: 'POST',
      headers: BOB,
      body: { trustedRoot, paths: [artifactPath] },
    });
    assert.deepEqual(bobBundle.body.files, []);

    const bobAttachments = await jsonRequest(base, '/api/attachments/context', {
      method: 'POST',
      headers: BOB,
      body: { trustedRoot, files: [path.relative(trustedRoot, artifactPath)] },
    });
    assert.deepEqual(bobAttachments.body.items, []);

    const bobGenericRename = await jsonRequest(base, '/api/file-ops/preview', {
      method: 'POST',
      headers: BOB,
      body: {
        trustedRoot,
        operations: [{ type: 'rename', path: artifactPath, newName: 'stolen.md' }],
      },
    });
    assert.equal(bobGenericRename.status, 404);
    assert.equal(fs.existsSync(artifactPath), true);

    const aliceGenericRename = await jsonRequest(base, '/api/file-ops/preview', {
      method: 'POST',
      headers: ALICE,
      body: {
        trustedRoot,
        operations: [{ type: 'rename', path: artifactPath, newName: 'wrong-route.md' }],
      },
    });
    assert.equal(aliceGenericRename.status, 400);

    const oldClaimPath = artifactOwnerClaimPath({ trustedRoot, artifactPath });
    const renamedPath = path.join(path.dirname(artifactPath), 'alice-renamed.md');
    const aliceRename = await jsonRequest(base, '/api/artifacts/rename', {
      method: 'POST',
      headers: { ...ALICE, 'idempotency-key': 'alice-static-rename' },
      body: { trustedRoot, path: artifactPath, newName: path.basename(renamedPath) },
    });
    assert.equal(aliceRename.status, 200);
    assert.equal(fs.existsSync(artifactPath), false);
    assert.equal(fs.existsSync(oldClaimPath), false);
    assert.equal(fs.existsSync(renamedPath), true);
    assert.equal(fs.existsSync(artifactOwnerClaimPath({
      trustedRoot,
      artifactPath: renamedPath,
    })), true);

    const aliceView = await fetch(
      `${base}/api/artifacts/view?path=${encodeURIComponent(renamedPath)}`,
      { headers: ALICE },
    );
    assert.equal(aliceView.status, 200);
    const bobRenamedView = await fetch(
      `${base}/api/artifacts/view?path=${encodeURIComponent(renamedPath)}`,
      { headers: BOB },
    );
    assert.equal(bobRenamedView.status, 404);
  } finally {
    await close(server);
  }
});

test('legacy artifacts remain local-only and are never claimed by the first authenticated read', async () => {
  const trustedRoot = tempRoot('kcw-legacy-art-owner-');
  const artifactRoot = path.join(trustedRoot, '.AgentCowork', 'artifacts');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const staticPath = path.join(artifactRoot, 'legacy.md');
  fs.writeFileSync(staticPath, 'legacy local', 'utf8');
  const legacy = buildLiveArtifact({
    trustedRoot,
    id: 'viz_legacy_local',
    title: 'Legacy local',
    viz: { kind: 'table', data: { columns: ['value'], rows: [['local']] } },
  });

  const authServer = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: true,
    authStore: siblingAuthStore(),
  });
  const authBase = await bind(authServer);
  try {
    const aliceList = await jsonRequest(authBase, '/api/artifacts', { headers: ALICE });
    assert.deepEqual(aliceList.body.artifacts, []);
    const aliceLive = await fetch(
      `${authBase}/api/artifacts/live/${legacy.id}`,
      { headers: ALICE },
    );
    assert.equal(aliceLive.status, 404);
    assert.equal(fs.existsSync(path.join(artifactRoot, '.owners')), false);
  } finally {
    await close(authServer);
  }

  const localServer = createServer({ trustedRoot, enableScheduler: false });
  const localBase = await bind(localServer);
  try {
    const localList = await jsonRequest(localBase, '/api/artifacts');
    assert.equal((localList.body.artifacts as unknown[]).length, 3);
    const localLive = await fetch(`${localBase}/api/artifacts/live/${legacy.id}`);
    assert.equal(localLive.status, 200);
  } finally {
    await close(localServer);
  }
});

test('corrupt sidecar and embedded owner metadata fail closed before connector calls', async () => {
  const trustedRoot = tempRoot('kcw-corrupt-art-owner-');
  let connectorCalls = 0;
  const toolRegistry = {
    registerMcpClient: () => 0,
    descriptor: () => ({ source: 'mcp:demo', name: 'mcp__demo__private', risk: 'low', mutating: false }),
    call: () => {
      connectorCalls += 1;
      return { viz: { kind: 'table', data: { columns: ['value'], rows: [['secret']] } } };
    },
  };
  const server = createServer({
    trustedRoot,
    enableScheduler: false,
    requireAuth: true,
    authStore: siblingAuthStore(),
    toolRegistry,
  });
  const base = await bind(server);
  try {
    const id = 'viz_corrupt_owner';
    await persistLiveArtifact(base, {
      id,
      title: 'Corrupt owner',
      kind: 'table',
      data: { columns: ['value'], rows: [['initial']] },
      dataSource: { type: 'connector-tool', tool: 'mcp__demo__private', args: {} },
    }, 'corrupt-owner-create');
    const htmlPath = path.join(trustedRoot, '.AgentCowork', 'artifacts', `${id}.html`);
    const manifestPath = path.join(trustedRoot, '.AgentCowork', 'artifacts', `${id}.json`);
    const originalManifest = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(originalManifest) as Record<string, unknown>;
    const embedded = manifest.owner as Record<string, unknown>;
    fs.writeFileSync(manifestPath, `${JSON.stringify({
      ...manifest,
      owner: { ...embedded, ownerSha256: '0'.repeat(64) },
    })}\n`, 'utf8');

    const corruptData = await jsonRequest(base, `/api/artifacts/data/${id}`, { headers: ALICE });
    assert.equal(corruptData.status, 404);
    const corruptLive = await fetch(`${base}/api/artifacts/live/${id}`, { headers: ALICE });
    assert.equal(corruptLive.status, 404);
    assert.equal(connectorCalls, 0);

    fs.writeFileSync(manifestPath, originalManifest, 'utf8');
    const htmlClaimPath = artifactOwnerClaimPath({ trustedRoot, artifactPath: htmlPath });
    fs.writeFileSync(htmlClaimPath, '{"broken":true}\n', 'utf8');
    const corruptClaimLive = await fetch(`${base}/api/artifacts/live/${id}`, { headers: ALICE });
    assert.equal(corruptClaimLive.status, 404);
    const corruptClaimView = await fetch(
      `${base}/api/artifacts/view?path=${encodeURIComponent(htmlPath)}`,
      { headers: ALICE },
    );
    assert.equal(corruptClaimView.status, 404);
    assert.equal(connectorCalls, 0);
  } finally {
    await close(server);
  }
});

test('claimed rename rejects reserved targets and rolls back file and claims on partial failures', () => {
  const trustedRoot = tempRoot('kcw-rename-owner-');
  const owner = { tenantId: TENANT, userId: 'alice' };
  const artifactRoot = path.join(trustedRoot, '.AgentCowork', 'artifacts');
  const makeOwnedSource = (name: string): string => {
    const source = path.join(artifactRoot, name);
    ensureArtifactOwnerClaim({ trustedRoot, artifactPath: source, owner });
    fs.writeFileSync(source, name, 'utf8');
    return source;
  };

  const reservedSource = makeOwnedSource('reserved-source.md');
  const reservedTarget = path.join(artifactRoot, 'reserved-target.md');
  ensureArtifactOwnerClaim({ trustedRoot, artifactPath: reservedTarget, owner });
  assert.throws(
    () => renameArtifact({
      trustedRoot,
      artifactPath: reservedSource,
      newName: path.basename(reservedTarget),
      context: owner,
    }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 409,
  );
  assert.equal(fs.existsSync(reservedSource), true);
  assert.equal(fs.existsSync(reservedTarget), false);

  const moveFailureSource = makeOwnedSource('move-failure.md');
  const moveFailureTarget = path.join(artifactRoot, 'move-failure-target.md');
  const originalLink = fs.linkSync;
  fs.linkSync = ((source: fs.PathLike, target: fs.PathLike) => {
    if (samePathReal(String(source), moveFailureSource) && samePathReal(String(target), moveFailureTarget)) {
      throw new Error('injected rename failure');
    }
    originalLink(source, target);
  }) as typeof fs.linkSync;
  try {
    assert.throws(
      () => renameArtifact({
        trustedRoot,
        artifactPath: moveFailureSource,
        newName: path.basename(moveFailureTarget),
        context: owner,
      }),
      /injected rename failure/,
    );
  } finally {
    fs.linkSync = originalLink;
  }
  assert.equal(fs.existsSync(moveFailureSource), true);
  assert.equal(fs.existsSync(moveFailureTarget), false);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({
    trustedRoot,
    artifactPath: moveFailureSource,
  })), true);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({
    trustedRoot,
    artifactPath: moveFailureTarget,
  })), false);

  const cleanupFailureSource = makeOwnedSource('cleanup-failure.md');
  const cleanupFailureTarget = path.join(artifactRoot, 'cleanup-failure-target.md');
  const sourceClaim = artifactOwnerClaimPath({
    trustedRoot,
    artifactPath: cleanupFailureSource,
  });
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = ((filePath: string) => {
    if (samePathReal(String(filePath), sourceClaim)) throw new Error('injected claim cleanup failure');
    originalUnlink(filePath);
  }) as typeof fs.unlinkSync;
  try {
    assert.throws(
      () => renameArtifact({
        trustedRoot,
        artifactPath: cleanupFailureSource,
        newName: path.basename(cleanupFailureTarget),
        context: owner,
      }),
      /injected claim cleanup failure/,
    );
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(fs.existsSync(cleanupFailureSource), true);
  assert.equal(fs.existsSync(cleanupFailureTarget), false);
  assert.equal(fs.existsSync(sourceClaim), true);
  assert.equal(fs.existsSync(artifactOwnerClaimPath({
    trustedRoot,
    artifactPath: cleanupFailureTarget,
  })), false);
});

test('native agent Read Write and Edit enforce the same artifact owner boundary', async () => {
  const trustedRoot = tempRoot('kcw-agent-art-owner-');
  const artifactPath = path.join(trustedRoot, '.AgentCowork', 'artifacts', 'agent-private.txt');
  const aliceTools = createAgentTools({
    trustedRoot,
    context: { tenantId: TENANT, userId: 'alice' },
  });
  const bobTools = createAgentTools({
    trustedRoot,
    context: { tenantId: TENANT, userId: 'bob' },
  });
  const handler = (
    tools: ReturnType<typeof createAgentTools>,
    name: string,
  ) => {
    const selected = tools.find((tool) => tool.name === name)?.handler;
    assert.equal(typeof selected, 'function');
    return selected as NonNullable<typeof selected>;
  };

  await handler(aliceTools, 'Write')({ path: artifactPath, content: 'alice private' });
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'alice private');
  await assert.rejects(
    () => handler(bobTools, 'Read')({ path: artifactPath }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );
  await assert.rejects(
    () => handler(bobTools, 'Edit')({
      path: artifactPath,
      old_string: 'alice',
      new_string: 'bob',
    }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );
  await assert.rejects(
    () => handler(bobTools, 'Write')({ path: artifactPath, content: 'bob overwrite' }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );
  const claimPath = artifactOwnerClaimPath({ trustedRoot, artifactPath });
  await assert.rejects(
    () => handler(aliceTools, 'Write')({ path: claimPath, content: '{"tampered":true}' }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );

  const bobGlob = await handler(bobTools, 'Glob')({ pattern: '**/*' }) as { matches?: unknown[] };
  assert.deepEqual(bobGlob.matches, []);
  const bobGrep = await handler(bobTools, 'Grep')({ pattern: 'alice private' }) as { hits?: unknown[] };
  assert.deepEqual(bobGrep.hits, []);
  const bobSearch = await handler(bobTools, 'SearchWorkspace')({ query: 'alice private' }) as { sources?: unknown[] };
  assert.deepEqual(bobSearch.sources, []);

  const csvPath = path.join(trustedRoot, '.AgentCowork', 'artifacts', 'agent-private.csv');
  await handler(aliceTools, 'Write')({ path: csvPath, content: 'name,value\nsecret,42\n' });
  await assert.rejects(
    () => handler(bobTools, 'AnalyzeDataFile')({ path: csvPath }),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );

  const builtins = createBuiltinTools({ enableWebTools: false });
  const builtin = (name: string) => {
    const selected = builtins.find((tool) => tool.name === name)?.handler;
    assert.equal(typeof selected, 'function');
    return selected as NonNullable<typeof selected>;
  };
  const bobContext = { trustedRoot, context: { tenantId: TENANT, userId: 'bob' } };
  const builtinSearch = await builtin('SearchWorkspace')({ query: 'secret' }, bobContext) as { sources?: unknown[] };
  assert.deepEqual(builtinSearch.sources, []);
  await assert.rejects(
    () => builtin('data.profile')({ path: csvPath }, bobContext),
    (error: unknown) => (error as { statusCode?: unknown }).statusCode === 404,
  );
  assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'alice private');
});
