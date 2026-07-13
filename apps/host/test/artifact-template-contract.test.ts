import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  applyArtifactTemplateCopy,
  buildArtifactTemplateContracts,
} from '../src/artifacts/artifact-template-contract.js';
import { createDocxDocument } from '../src/artifacts/office-writers.js';
import { readZipEntries } from '../src/workspace/zip-utils.js';
import { createTemplateLockedToolset } from '../src/routes/agent-template-mode.js';

const owner = { tenantId: 'local', userId: 'local' };

function workspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agent-template-'));
}

test('template contract exposes editable node ids and DOCX copy preserves unrelated package parts', () => {
  const root = workspace();
  const templatePath = path.join(root, 'brand.docx');
  const original = createDocxDocument({ title: '品牌周报', paragraphs: ['{{summary}}', '固定页脚'] });
  fs.writeFileSync(templatePath, original);
  const [contract] = buildArtifactTemplateContracts({ trustedRoot: root, templateFiles: [templatePath], context: owner });
  assert.ok(contract);
  const target = contract.sections.flatMap((section) => section.nodes).find((node) => node.text === '{{summary}}');
  assert.ok(target);

  const result = applyArtifactTemplateCopy({
    trustedRoot: root,
    context: owner,
    contract,
    copyName: 'weekly.docx',
    changes: [{ targetId: target.id, text: '本周完成模板锁定模式。' }],
  });

  assert.equal(result.path, path.join(root, '.AgentCowork', 'artifacts', 'weekly.docx'));
  assert.ok(fs.existsSync(result.path));
  const originalParts = readZipEntries(original).map((entry) => entry.name);
  const nextParts = readZipEntries(fs.readFileSync(result.path)).map((entry) => entry.name);
  assert.deepEqual(nextParts, originalParts);
  assert.throws(() => applyArtifactTemplateCopy({
    trustedRoot: root,
    context: owner,
    contract,
    copyName: 'weekly.docx',
    changes: [{ targetId: target.id, text: '不得覆盖' }],
  }), /already exists/i);
});

test('HTML template accepts text replacement but rejects structural or style drift', () => {
  const root = workspace();
  const templatePath = path.join(root, 'landing.html');
  fs.writeFileSync(templatePath, '<main class="hero"><style>.hero{color:red}</style><h1>标题</h1><p>说明</p></main>');
  const [contract] = buildArtifactTemplateContracts({ trustedRoot: root, templateFiles: [templatePath], context: owner });
  assert.ok(contract);

  const accepted = applyArtifactTemplateCopy({
    trustedRoot: root,
    context: owner,
    contract,
    copyName: 'landing-copy.html',
    changes: [{ targetId: 'document', text: '<main class="hero"><style>.hero{color:red}</style><h1>新标题</h1><p>新说明</p></main>' }],
  });
  assert.ok(fs.existsSync(accepted.path));

  assert.throws(() => applyArtifactTemplateCopy({
    trustedRoot: root,
    context: owner,
    contract,
    copyName: 'landing-drift.html',
    changes: [{ targetId: 'document', text: '<main class="hero changed"><style>.hero{color:blue}</style><h1>新标题</h1><p>新说明</p></main>' }],
  }), /structure or styles/i);
});

test('template lock removes generic mutation and delegation escape hatches', () => {
  const tools = ['Read', 'Write', 'Edit', 'Shell', 'WebFetch', 'Skill', 'Agent', 'AgentParallel'].map((name) => ({ name }));
  const applyTool = { name: 'ApplyArtifactTemplate' };
  const locked = createTemplateLockedToolset(tools, applyTool);

  assert.deepEqual(locked.map((tool) => tool.name), ['Read', 'WebFetch', 'ApplyArtifactTemplate']);
});
