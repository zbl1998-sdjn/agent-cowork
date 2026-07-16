import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  discoverSkillPacks,
  isValidSkillPackName,
  parseSkillMd,
  readSkillPackFile,
} from '../src/skills/skill-md-loader.js';

function makeRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'acw-skillmd-'));
}

function writePack(root: string, dirName: string, skillMd: string): string {
  const dir = path.join(root, '.AgentCowork', 'skills', dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd, 'utf8');
  return dir;
}

const VALID_SKILL_MD = [
  '---',
  'name: pdf-processing',
  'description: 提取 PDF 文本、填表单、合并文件。处理 PDF 时使用。',
  'license: Apache-2.0',
  'metadata:',
  '  author: example-org',
  '---',
  '',
  '# 步骤',
  '1. 先读文件。',
].join('\n');

test('isValidSkillPackName enforces the agentskills.io name rules', () => {
  assert.equal(isValidSkillPackName('pdf-processing'), true);
  assert.equal(isValidSkillPackName('a'), true);
  assert.equal(isValidSkillPackName('PDF-Processing'), false);
  assert.equal(isValidSkillPackName('-pdf'), false);
  assert.equal(isValidSkillPackName('pdf-'), false);
  assert.equal(isValidSkillPackName('pdf--processing'), false);
  assert.equal(isValidSkillPackName('a'.repeat(65)), false);
  assert.equal(isValidSkillPackName(''), false);
});

test('parseSkillMd extracts top-level scalars, tolerates nested metadata, returns body', () => {
  const parsed = parseSkillMd(VALID_SKILL_MD);
  assert.ok(parsed);
  assert.equal(parsed.fields.name, 'pdf-processing');
  assert.equal(parsed.fields.license, 'Apache-2.0');
  assert.match(parsed.body, /# 步骤/);
  assert.doesNotMatch(parsed.body, /description:/);
});

test('parseSkillMd unquotes quoted values and rejects missing frontmatter', () => {
  const parsed = parseSkillMd('---\nname: "quoted-name"\ndescription: \'single\'\n---\nbody');
  assert.ok(parsed);
  assert.equal(parsed.fields.name, 'quoted-name');
  assert.equal(parsed.fields.description, 'single');
  assert.equal(parseSkillMd('# 没有 frontmatter'), null);
  assert.equal(parseSkillMd('---\nname: x'), null);
});

test('discoverSkillPacks returns empty when the skills dir does not exist', () => {
  const root = makeRoot();
  assert.deepEqual(discoverSkillPacks(root), { packs: [], warnings: [] });
});

test('discoverSkillPacks lists a valid pack and sanitizes invisible characters in description', () => {
  const root = makeRoot();
  const zwsp = String.fromCharCode(0x200b);
  writePack(root, 'pdf-processing', [
    '---',
    'name: pdf-processing',
    `description: 提取${zwsp} PDF 文本。`,
    '---',
    '正文',
  ].join('\n'));
  const { packs, warnings } = discoverSkillPacks(root);
  assert.deepEqual(warnings, []);
  assert.equal(packs.length, 1);
  assert.ok(packs[0]);
  assert.equal(packs[0].name, 'pdf-processing');
  assert.equal(packs[0].description.includes(zwsp), false);
  assert.match(packs[0].description, /提取 PDF 文本。/);
});

test('discoverSkillPacks skips name/dir mismatch, bad dir names, and missing description', () => {
  const root = makeRoot();
  writePack(root, 'mismatch-pack', '---\nname: other-name\ndescription: x\n---\n');
  writePack(root, 'no-desc', '---\nname: no-desc\n---\n');
  const badDir = path.join(root, '.AgentCowork', 'skills', 'Bad--Name');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'SKILL.md'), '---\nname: bad\ndescription: x\n---\n');
  const { packs, warnings } = discoverSkillPacks(root);
  assert.equal(packs.length, 0);
  assert.equal(warnings.length, 3);
  assert.ok(warnings.some((w) => w.includes('mismatch-pack')));
  assert.ok(warnings.some((w) => w.includes('no-desc')));
  assert.ok(warnings.some((w) => w.includes('Bad--Name')));
});

test('discoverSkillPacks skips a symlinked pack directory', (t) => {
  const root = makeRoot();
  writePack(root, 'real-pack', VALID_SKILL_MD.replace('pdf-processing', 'real-pack'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'acw-outside-'));
  fs.writeFileSync(path.join(outside, 'SKILL.md'), '---\nname: linked-pack\ndescription: x\n---\n');
  try {
    fs.symlinkSync(outside, path.join(root, '.AgentCowork', 'skills', 'linked-pack'), 'junction');
  } catch {
    t.skip('无法在当前环境创建 symlink/junction');
    return;
  }
  const { packs } = discoverSkillPacks(root);
  assert.deepEqual(packs.map((p) => p.name), ['real-pack']);
});

test('readSkillPackFile returns the SKILL.md body without frontmatter', () => {
  const root = makeRoot();
  writePack(root, 'pdf-processing', VALID_SKILL_MD);
  const result = readSkillPackFile(root, 'pdf-processing');
  assert.equal(result.file, 'SKILL.md');
  assert.match(result.content, /# 步骤/);
  assert.doesNotMatch(result.content, /description:/);
});

test('readSkillPackFile clips an oversized body with a truncation note', () => {
  const root = makeRoot();
  const bigBody = 'x'.repeat(30_000);
  writePack(root, 'big-pack', `---\nname: big-pack\ndescription: 大\n---\n${bigBody}`);
  const result = readSkillPackFile(root, 'big-pack');
  assert.ok(result.content.length < bigBody.length);
  assert.match(result.content, /已截断/);
});

test('readSkillPackFile reads a single-level references file and rejects everything else', () => {
  const root = makeRoot();
  const dir = writePack(root, 'ref-pack', '---\nname: ref-pack\ndescription: x\n---\n正文');
  fs.mkdirSync(path.join(dir, 'references'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'references', 'REFERENCE.md'), '细节文档');
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'scripts', 'run.py'), 'print(1)');

  const ok = readSkillPackFile(root, 'ref-pack', 'references/REFERENCE.md');
  assert.equal(ok.content, '细节文档');
  const okBackslash = readSkillPackFile(root, 'ref-pack', 'references\\REFERENCE.md');
  assert.equal(okBackslash.file, 'references/REFERENCE.md');

  assert.throws(() => readSkillPackFile(root, 'ref-pack', 'scripts/run.py'), /references/);
  assert.throws(() => readSkillPackFile(root, 'ref-pack', 'references/../../secret.txt'), /references/);
  assert.throws(() => readSkillPackFile(root, 'ref-pack', '../other-pack/SKILL.md'), /references/);
  assert.throws(() => readSkillPackFile(root, 'ref-pack', 'references/missing.md'), /不存在/);
});

test('readSkillPackFile rejects unknown packs and invalid names', () => {
  const root = makeRoot();
  assert.throws(() => readSkillPackFile(root, 'no-such-pack'), /不存在/);
  assert.throws(() => readSkillPackFile(root, '../escape'), /不合法/);
  assert.throws(() => readSkillPackFile(root, 'Bad--Name'), /不合法/);
});
