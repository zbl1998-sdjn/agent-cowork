import fs from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { chunkText } from '../src/workspace/index/chunk.js';
import { createWorkspaceIndex } from '../src/workspace/index/store.js';
import { createWorkspaceRetriever } from '../src/workspace/index/retriever.js';
import { makeTestWorkspace } from './test-fixtures.js';

describe('workspace index chunking', () => {
  it('chunks text by lines and preserves source line ranges', () => {
    const chunks = chunkText({
      sourcePath: 'docs/notes.md',
      text: 'alpha\nbeta\n\ngamma\ndelta',
      maxChunkLines: 2,
      maxChunkBytes: 1024,
    });

    assert.deepEqual(
      chunks.map(({ sourcePath, startLine, endLine, text }) => ({ sourcePath, startLine, endLine, text })),
      [
        { sourcePath: 'docs/notes.md', startLine: 1, endLine: 2, text: 'alpha\nbeta' },
        { sourcePath: 'docs/notes.md', startLine: 3, endLine: 4, text: '\ngamma' },
        { sourcePath: 'docs/notes.md', startLine: 5, endLine: 5, text: 'delta' },
      ],
    );
  });

  it('splits oversized lines without losing their original line number', () => {
    const chunks = chunkText({
      sourcePath: 'big.txt',
      text: 'abcdef\nlast',
      maxChunkLines: 10,
      maxChunkBytes: 3,
    });

    assert.deepEqual(
      chunks.map(({ startLine, endLine, text }) => ({ startLine, endLine, text })),
      [
        { startLine: 1, endLine: 1, text: 'abc' },
        { startLine: 1, endLine: 1, text: 'def' },
        { startLine: 2, endLine: 2, text: 'las' },
        { startLine: 2, endLine: 2, text: 't' },
      ],
    );
  });
});

describe('workspace index store and retriever', () => {
  it('upserts and removes chunks incrementally within the root', () => {
    const root = makeTestWorkspace('kcw-index');
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    fs.writeFileSync(a, 'alpha contract terms', 'utf8');
    fs.writeFileSync(b, 'beta invoice terms', 'utf8');

    const index = createWorkspaceIndex({ root });
    assert.equal(index.root, fs.realpathSync.native(root));

    index.upsert({ path: a, text: fs.readFileSync(a, 'utf8'), maxChunkLines: 1 });
    index.upsert({ path: b, text: fs.readFileSync(b, 'utf8'), maxChunkLines: 1 });
    assert.deepEqual(index.search({ query: 'terms' }).chunks.map((c) => path.basename(c.sourcePath)).sort(), ['a.txt', 'b.txt']);

    fs.writeFileSync(a, 'alpha updated warranty', 'utf8');
    index.upsert({ path: a, text: fs.readFileSync(a, 'utf8'), maxChunkLines: 1 });
    assert.deepEqual(index.search({ query: 'contract' }).chunks, []);
    assert.deepEqual(index.search({ query: 'warranty' }).chunks.map((c) => path.basename(c.sourcePath)), ['a.txt']);

    index.remove(a);
    assert.deepEqual(index.search({ query: 'alpha warranty' }).chunks, []);
    assert.deepEqual(index.search({ query: 'invoice' }).chunks.map((c) => path.basename(c.sourcePath)), ['b.txt']);
  });

  it('rejects paths outside the trusted root and keeps them out of the index', () => {
    const root = makeTestWorkspace('kcw-index-root');
    const outsideRoot = makeTestWorkspace('kcw-index-outside');
    const outside = path.join(outsideRoot, 'leak.txt');
    fs.writeFileSync(outside, 'outside secret keyword', 'utf8');

    const index = createWorkspaceIndex({ root });
    assert.throws(() => index.upsert({ path: outside, text: fs.readFileSync(outside, 'utf8') }), /trusted root/i);
    assert.throws(() => index.remove(outside), /trusted root/i);
    assert.deepEqual(index.search({ query: 'secret' }).chunks, []);
  });

  it('retrieves keyword matches with chunk and source references', () => {
    const root = makeTestWorkspace('kcw-retriever');
    const plan = path.join(root, 'plan.md');
    const notes = path.join(root, 'notes.md');
    const realRoot = fs.realpathSync.native(root);
    const realPlan = path.join(realRoot, 'plan.md');

    const retriever = createWorkspaceRetriever({ root });
    retriever.upsert({
      path: plan,
      text: 'Roadmap\nLocal RAG should cite workspace sources\nShip later',
      maxChunkLines: 1,
    });
    retriever.upsert({
      path: notes,
      text: 'Meeting notes\nBudget only',
      maxChunkLines: 1,
    });

    const result = retriever.search('rag sources');
    assert.equal(result.chunks.length, 1);
    assert.equal(result.chunks[0].sourcePath, realPlan);
    assert.equal(result.chunks[0].startLine, 2);
    assert.equal(result.chunks[0].endLine, 2);
    assert.deepEqual(result.sources, [{ path: realPlan, startLine: 2, endLine: 2 }]);
  });
});
