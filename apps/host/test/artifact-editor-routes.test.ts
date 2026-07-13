import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { openEditableArtifact } from '../src/artifacts/office-component-editor.js';
import { createDocxDocument } from '../src/artifacts/office-writers.js';
import { createServer } from '../src/server.js';
import { bind, close, jsonRequest, stringField, tempRoot } from './helpers/host-http.js';

test('artifact editor opens a DOCX and saves an approved copy without overwriting the source', async () => {
  const trustedRoot = tempRoot('kcw-office-editor-');
  const artifactRoot = path.join(trustedRoot, '.AgentCowork', 'artifacts');
  const sourcePath = path.join(artifactRoot, 'weekly.docx');
  fs.mkdirSync(artifactRoot, { recursive: true });
  fs.writeFileSync(sourcePath, createDocxDocument({ title: '周报', paragraphs: ['旧内容'] }));
  const original = fs.readFileSync(sourcePath);
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const opened = await jsonRequest(base, '/api/artifacts/editor/session', {
      method: 'POST',
      body: { trustedRoot, path: sourcePath },
    });
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    const session = opened.body.session as Record<string, unknown>;
    const sections = session.sections as Array<{ nodes: Array<{ id: string; text: string }> }>;
    const target = sections.flatMap((section) => section.nodes).find((node) => node.text === '旧内容');
    assert.ok(target);

    const edit = {
      trustedRoot,
      path: sourcePath,
      revisionSha256: String(session.revisionSha256),
      copyName: 'weekly-edited.docx',
      changes: [{ targetId: target.id, text: '新内容' }],
    };
    const rejected = await jsonRequest(base, '/api/artifacts/editor/save', {
      method: 'POST',
      headers: { 'idempotency-key': 'office-save-without-approval' },
      body: edit,
    });
    assert.equal(rejected.status, 428);

    const preview = await jsonRequest(base, '/api/artifacts/editor/save/preview', { method: 'POST', body: edit });
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    const saved = await jsonRequest(base, '/api/artifacts/editor/save', {
      method: 'POST',
      headers: { 'idempotency-key': 'office-save-approved' },
      body: { ...edit, fileOperationApprovalId: stringField(preview.body, 'fileOperationApprovalId') },
    });
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.deepEqual(fs.readFileSync(sourcePath), original, 'source file must remain byte-identical');

    const copyPath = path.join(artifactRoot, 'weekly-edited.docx');
    assert.equal(stringField(saved.body, 'path'), copyPath);
    const copySession = openEditableArtifact('weekly-edited.docx', fs.readFileSync(copyPath));
    assert.ok(copySession.sections.flatMap((section) => section.nodes).some((node) => node.text === '新内容'));
  } finally {
    await close(server);
  }
});

test('artifact editor rejects unsupported copy extensions before issuing approval', async () => {
  const trustedRoot = tempRoot('kcw-office-editor-');
  const artifactRoot = path.join(trustedRoot, '.AgentCowork', 'artifacts');
  const sourcePath = path.join(artifactRoot, 'weekly.docx');
  fs.mkdirSync(artifactRoot, { recursive: true });
  const source = createDocxDocument({ title: '周报', paragraphs: ['正文'] });
  fs.writeFileSync(sourcePath, source);
  const session = openEditableArtifact('weekly.docx', source);
  const target = session.sections.flatMap((section) => section.nodes).find((node) => node.text === '正文');
  assert.ok(target);
  const server = createServer({ trustedRoot, enableScheduler: false });
  const base = await bind(server);
  try {
    const result = await jsonRequest(base, '/api/artifacts/editor/save/preview', {
      method: 'POST',
      body: {
        trustedRoot,
        path: sourcePath,
        revisionSha256: session.revisionSha256,
        copyName: '../escaped.html',
        changes: [{ targetId: target.id, text: '新正文' }],
      },
    });
    assert.equal(result.status, 400);
    assert.match(String(result.body.error), /file name|extension/i);
  } finally {
    await close(server);
  }
});
