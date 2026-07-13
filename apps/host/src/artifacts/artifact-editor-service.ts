// Office/Web 编辑文件服务(host · L1 领域层 · artifacts)
// ---------------------------------------------------------------------------
// 职责:在 artifact 路径牢笼内读取编辑会话、生成可审批保存预案，并原子发布带 owner claim 的副本。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { writePrivateFileOnceAtomically } from '../security/private-atomic-file.js';
import { createArtifactAccessGuards } from './artifact-access-guards.js';
import {
  applyEditableArtifact,
  editableArtifactKind,
  openEditableArtifact,
  type EditableArtifactChange,
  type EditableArtifactSession,
} from './office-component-editor.js';

type EditorInput = Readonly<{
  trustedRoot: string;
  artifactPath: string;
  context: unknown;
}>;

export type ArtifactEditorSavePlan = Readonly<{
  sourcePath: string;
  targetPath: string;
  copyName: string;
  output: Buffer;
  outputSha256: string;
  operations: ReadonlyArray<Readonly<Record<string, unknown>>>;
}>;

export type ArtifactEditorExternalCopyPlan = Readonly<{
  sourcePath: string;
  targetPath: string;
  copyName: string;
  sourceRevisionSha256: string;
  operations: ReadonlyArray<Readonly<Record<string, unknown>>>;
}>;

function httpError(statusCode: number, message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

function artifactRoot(trustedRoot: string): string {
  return path.join(path.resolve(trustedRoot), '.AgentCowork', 'artifacts');
}

function assertCatalogPath(trustedRoot: string, artifactPath: string): void {
  const relative = path.relative(artifactRoot(trustedRoot), artifactPath).replace(/\\/g, '/');
  if (!relative || relative === '..' || relative.startsWith('../') || relative.startsWith('.owners/')) {
    throw httpError(404, 'artifact not found');
  }
}

function readSource(input: EditorInput): { path: string; content: Buffer } {
  const guards = createArtifactAccessGuards(input.trustedRoot, input.context);
  const sourcePath = guards.readPath(input.artifactPath);
  assertCatalogPath(input.trustedRoot, sourcePath);
  try {
    return { path: sourcePath, content: fs.readFileSync(sourcePath) };
  } catch (error) {
    if ((error as { code?: unknown }).code === 'ENOENT') throw httpError(404, 'artifact not found');
    throw error;
  }
}

function validateCopyName(sourcePath: string, value: string): string {
  const copyName = String(value || '').trim();
  if (!copyName || copyName.length > 180 || path.basename(copyName) !== copyName || copyName === '.' || copyName === '..') {
    throw httpError(400, 'copyName must be a plain file name');
  }
  if (path.extname(copyName).toLowerCase() !== path.extname(sourcePath).toLowerCase()) {
    throw httpError(400, 'copyName must keep the source file extension');
  }
  editableArtifactKind(copyName);
  return copyName;
}

function sha256(content: Buffer): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function openArtifactEditorSession(input: EditorInput): EditableArtifactSession {
  const source = readSource(input);
  return openEditableArtifact(path.basename(source.path), source.content);
}

export function buildArtifactEditorExternalCopyPlan(
  input: EditorInput & { copyName: string; allowExisting?: boolean },
): ArtifactEditorExternalCopyPlan {
  const source = readSource(input);
  const kind = editableArtifactKind(source.path);
  if (kind === 'html') throw httpError(400, 'ONLYOFFICE mode supports DOCX, XLSX and PPTX artifacts');
  const copyName = validateCopyName(source.path, input.copyName);
  const targetPath = path.join(path.dirname(source.path), copyName);
  assertCatalogPath(input.trustedRoot, targetPath);
  if (path.resolve(targetPath) === path.resolve(source.path)) throw httpError(409, 'save a copy with a different file name');
  if (!input.allowExisting && fs.existsSync(targetPath)) throw httpError(409, 'artifact copy already exists');
  const sourceRevisionSha256 = sha256(source.content);
  return Object.freeze({
    sourcePath: source.path,
    targetPath,
    copyName,
    sourceRevisionSha256,
    operations: Object.freeze([Object.freeze({
      type: 'create-onlyoffice-artifact-copy',
      sourcePath: source.path,
      targetPath,
      sourceRevisionSha256,
    })]),
  });
}

export function inspectArtifactEditorExternalCopy(
  input: Pick<EditorInput, 'trustedRoot' | 'context'>,
  plan: ArtifactEditorExternalCopyPlan,
): { saved: false } | { saved: true; outputSha256: string } {
  if (!fs.existsSync(plan.targetPath)) return { saved: false };
  const guards = createArtifactAccessGuards(input.trustedRoot, input.context);
  const targetPath = guards.readPath(plan.targetPath);
  return { saved: true, outputSha256: sha256(fs.readFileSync(targetPath)) };
}

export function readArtifactEditorExternalSource(
  input: Pick<EditorInput, 'trustedRoot' | 'context'> & Pick<ArtifactEditorExternalCopyPlan, 'sourcePath' | 'sourceRevisionSha256'>,
): { name: string; content: Buffer } {
  const source = readSource({ trustedRoot: input.trustedRoot, artifactPath: input.sourcePath, context: input.context });
  if (sha256(source.content) !== input.sourceRevisionSha256) {
    throw httpError(409, 'source artifact changed after the ONLYOFFICE session started');
  }
  return { name: path.basename(source.path), content: source.content };
}

export function publishArtifactEditorExternalCopy(
  input: Pick<EditorInput, 'trustedRoot' | 'context'>,
  plan: ArtifactEditorExternalCopyPlan,
  output: Buffer,
): { outputSha256: string; idempotent: boolean } {
  openEditableArtifact(plan.copyName, output);
  const outputSha256 = sha256(output);
  const guards = createArtifactAccessGuards(input.trustedRoot, input.context);
  if (fs.existsSync(plan.targetPath)) {
    const existingPath = guards.readPath(plan.targetPath);
    if (sha256(fs.readFileSync(existingPath)) === outputSha256) return { outputSha256, idempotent: true };
    throw httpError(409, 'artifact copy already exists with different content');
  }
  const prepared = guards.prepareWrite(plan.targetPath, output);
  try {
    const published = writePrivateFileOnceAtomically(prepared.path, output);
    if (!published) throw httpError(409, 'artifact copy already exists');
  } catch (error) {
    prepared.preparation?.abort();
    throw error;
  }
  return { outputSha256, idempotent: false };
}

export function buildArtifactEditorSavePlan(
  input: EditorInput & {
    revisionSha256: string;
    copyName: string;
    changes: EditableArtifactChange[];
  },
): ArtifactEditorSavePlan {
  const source = readSource(input);
  const copyName = validateCopyName(source.path, input.copyName);
  const targetPath = path.join(path.dirname(source.path), copyName);
  assertCatalogPath(input.trustedRoot, targetPath);
  if (path.resolve(targetPath) === path.resolve(source.path)) throw httpError(409, 'save a copy with a different file name');
  if (fs.existsSync(targetPath)) throw httpError(409, 'artifact copy already exists');
  let output: Buffer;
  try {
    output = applyEditableArtifact(
      path.basename(source.path),
      source.content,
      input.revisionSha256,
      input.changes,
    );
  } catch (error) {
    if (/changed since it was opened/i.test(String(error))) throw httpError(409, (error as Error).message);
    throw error;
  }
  const outputSha256 = sha256(output);
  return Object.freeze({
    sourcePath: source.path,
    targetPath,
    copyName,
    output,
    outputSha256,
    operations: Object.freeze([Object.freeze({
      type: 'create-artifact-copy',
      sourcePath: source.path,
      targetPath,
      sourceRevisionSha256: input.revisionSha256,
      outputSha256,
    })]),
  });
}

export function publishArtifactEditorSavePlan(
  input: Pick<EditorInput, 'trustedRoot' | 'context'>,
  plan: ArtifactEditorSavePlan,
): void {
  const guards = createArtifactAccessGuards(input.trustedRoot, input.context);
  const prepared = guards.prepareWrite(plan.targetPath, plan.output);
  try {
    const published = writePrivateFileOnceAtomically(prepared.path, plan.output);
    if (!published) throw httpError(409, 'artifact copy already exists');
  } catch (error) {
    prepared.preparation?.abort();
    throw error;
  }
}
