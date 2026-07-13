// 用户版式模板契约(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:读取 Office/HTML 模板、暴露可填节点，并以“只创建副本”的方式应用修改。
import fs from 'node:fs';
import path from 'node:path';

import { createArtifactAccessGuards } from './artifact-access-guards.js';
import { applyEditableArtifact, openEditableArtifact } from './office-component-editor.js';
import type { EditableArtifactChange, EditableArtifactKind, EditableArtifactSection } from './office-editor-types.js';

const MAX_TEMPLATE_FILES = 4;
const MAX_TEMPLATE_BYTES = 20 * 1024 * 1024;
const SUPPORTED_TEMPLATE_RE = /\.(docx|xlsx|pptx|html?)$/i;

export type ArtifactTemplateContract = Readonly<{
  sourcePath: string;
  name: string;
  kind: EditableArtifactKind;
  revisionSha256: string;
  sections: EditableArtifactSection[];
  htmlSource?: string;
}>;

type ContractInput = {
  trustedRoot: string;
  templateFiles: string[];
  context: unknown;
};

type ApplyInput = {
  trustedRoot: string;
  context: unknown;
  contract: ArtifactTemplateContract;
  copyName: string;
  changes: EditableArtifactChange[];
};

function assertCopyName(copyName: string, sourceName: string): string {
  const name = String(copyName || '').trim();
  if (!name || name !== path.basename(name) || name === '.' || name === '..') {
    throw new Error('template copyName must be a plain file name');
  }
  if (path.extname(name).toLowerCase() !== path.extname(sourceName).toLowerCase()) {
    throw new Error('template copy must keep the source file extension');
  }
  return name;
}

function protectedHtmlTokens(source: string): string[] {
  return source.match(/<!--[\s\S]*?-->|<!doctype\b[^>]*>|<style\b[^>]*>[\s\S]*?<\/style\s*>|<script\b[^>]*>[\s\S]*?<\/script\s*>|<\/?[a-z][^>]*>/gi) || [];
}

export function assertHtmlTemplateStructure(original: string, next: string): void {
  if (JSON.stringify(protectedHtmlTokens(original)) !== JSON.stringify(protectedHtmlTokens(next))) {
    throw new Error('HTML template structure or styles changed; template lock only allows text replacement');
  }
}

export function buildArtifactTemplateContracts(input: ContractInput): ArtifactTemplateContract[] {
  if (!Array.isArray(input.templateFiles) || input.templateFiles.length === 0) return [];
  if (input.templateFiles.length > MAX_TEMPLATE_FILES) throw new Error(`at most ${MAX_TEMPLATE_FILES} layout templates are allowed`);
  const guards = createArtifactAccessGuards(input.trustedRoot, input.context);
  const seen = new Set<string>();
  return input.templateFiles.map((candidate) => {
    const sourcePath = guards.readPath(candidate);
    if (seen.has(sourcePath)) throw new Error('duplicate layout template path');
    seen.add(sourcePath);
    const name = path.basename(sourcePath);
    if (!SUPPORTED_TEMPLATE_RE.test(name)) throw new Error(`unsupported layout template: ${name}`);
    const stat = fs.statSync(sourcePath);
    if (!stat.isFile()) throw new Error(`layout template is not a file: ${name}`);
    if (stat.size > MAX_TEMPLATE_BYTES) throw new Error(`layout template exceeds ${MAX_TEMPLATE_BYTES / 1024 / 1024} MB: ${name}`);
    const session = openEditableArtifact(name, fs.readFileSync(sourcePath));
    return Object.freeze({
      sourcePath,
      name,
      kind: session.kind,
      revisionSha256: session.revisionSha256,
      sections: session.sections,
      ...(session.htmlSource === undefined ? {} : { htmlSource: session.htmlSource }),
    });
  });
}

export function applyArtifactTemplateCopy(input: ApplyInput): { ok: true; path: string; templatePath: string } {
  const guards = createArtifactAccessGuards(input.trustedRoot, input.context);
  const sourcePath = guards.readPath(input.contract.sourcePath);
  const copyName = assertCopyName(input.copyName, input.contract.name);
  const targetPath = path.join(input.trustedRoot, '.AgentCowork', 'artifacts', copyName);
  const source = fs.readFileSync(sourcePath);
  let output = applyEditableArtifact(
    input.contract.name,
    source,
    input.contract.revisionSha256,
    input.changes,
  );
  if (input.contract.kind === 'html') {
    assertHtmlTemplateStructure(input.contract.htmlSource || source.toString('utf8'), output.toString('utf8'));
  }
  const prepared = guards.prepareWrite(targetPath, output);
  try {
    fs.mkdirSync(path.dirname(prepared.path), { recursive: true });
    fs.writeFileSync(prepared.path, output, { flag: 'wx' });
  } catch (error) {
    prepared.preparation?.abort();
    throw error;
  } finally {
    output = Buffer.alloc(0);
  }
  return { ok: true, path: prepared.path, templatePath: sourcePath };
}
