import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createAgentTools } from '../src/kimi/agent-tools.js';
import { LocalSubprocessSandbox } from '../src/sandbox/local-sandbox.js';
import {
  agentTool,
  parseEditResult,
  parseGlobResult,
  parseGrepResult,
  parseReadResult,
  parseShellResult,
  parseWriteResult,
} from './helpers/agent.js';
import { tempRoot } from './helpers/host-http.js';
import type { SandboxLike } from '../src/kimi/agent-tools.js';

test('native agent tools (Read/Write/Glob) are jailed to the workspace', async () => {
  const root = tempRoot('kcw-agent-');
  fs.writeFileSync(path.join(root, 'a.txt'), 'hello', 'utf8');
  fs.writeFileSync(path.join(root, '.npmrc'), 'token=secret', 'utf8');

  const tools = createAgentTools({ trustedRoot: root });
  const byName = (name: string) => agentTool(tools, name);

  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    'AnalyzeDataFile',
    'CreateDataChartArtifact',
    'Edit',
    'GitCommit',
    'GitDiff',
    'GitLog',
    'GitStatus',
    'Glob',
    'Grep',
    'PlanFileOrganization',
    'Read',
    'SearchWorkspace',
    'WebFetch',
    'Write',
  ]);

  const glob = parseGlobResult(await byName('Glob').handler({ pattern: '*.txt' }));
  assert.ok(glob.matches.includes('a.txt'));
  assert.equal(glob.matches.some((match) => match.includes('.npmrc')), false);

  const grep = parseGrepResult(await byName('Grep').handler({ pattern: 'secret', maxResults: 5 }));
  assert.deepEqual(grep.hits, []);

  const read = parseReadResult(await byName('Read').handler({ path: 'a.txt' }));
  assert.equal(read.content, 'hello');
  await assert.rejects(() => byName('Read').handler({ path: '.npmrc' }), /blocked by policy/);

  const wrote = parseWriteResult(await byName('Write').handler({ path: 'sub/b.txt', content: 'world' }));
  assert.equal(wrote.ok, true);
  assert.equal(fs.readFileSync(path.join(root, 'sub', 'b.txt'), 'utf8'), 'world');

  assert.equal(byName('Write').mutating, true);
  assert.equal(byName('Read').mutating, false);
  assert.equal(byName('SearchWorkspace').mutating, false);
  assert.equal(byName('PlanFileOrganization').mutating, false);
  assert.equal(byName('AnalyzeDataFile').mutating, false);
  assert.equal(byName('CreateDataChartArtifact').mutating, true);
  assert.equal(byName('CreateDataChartArtifact').risk, 'high');
  assert.equal(byName('CreateDataChartArtifact').requiresApproval, true);
  assert.equal(byName('GitStatus').mutating, false);
  assert.equal(byName('GitCommit').mutating, true);
  assert.equal(byName('GitCommit').risk, 'high');
  await assert.rejects(() => byName('Write').handler({ path: '../escape.txt', content: 'x' }), /escaped|Sensitive|outside/i);
});

test('Edit replaces a string in a workspace file', async () => {
  const root = tempRoot('kcw-agent-');
  fs.writeFileSync(path.join(root, 'c.txt'), 'foo bar foo', 'utf8');
  const edit = agentTool(createAgentTools({ trustedRoot: root }), 'Edit');

  await edit.handler({ path: 'c.txt', old_string: 'foo', new_string: 'baz' });
  assert.equal(fs.readFileSync(path.join(root, 'c.txt'), 'utf8'), 'baz bar foo');

  const all = parseEditResult(await edit.handler({
    path: 'c.txt',
    old_string: 'foo',
    new_string: 'X',
    replace_all: true,
  }));
  assert.equal(all.replacements, 1);
});

test('Shell captures stdout from quoted node -e commands on Windows local backend', {
  skip: process.platform !== 'win32' ? 'Windows shell quoting regression' : false,
}, async () => {
  const root = tempRoot('kcw-agent-');
  const tools = createAgentTools({
    trustedRoot: root,
    sandbox: new LocalSubprocessSandbox() as unknown as SandboxLike,
    sandboxLimits: { allowTools: ['node'] },
  });
  const shell = agentTool(tools, 'Shell');

  const result = parseShellResult(await shell.handler({ command: 'node -e "process.stdout.write(\'shell-ok\')"' }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, 'shell-ok');
  assert.equal(result.stderr, '');
});
