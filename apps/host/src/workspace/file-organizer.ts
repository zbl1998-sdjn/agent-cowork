// 文件整理预案(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:为批量整理生成「操作预案」(只读,不落盘):按扩展名归类(byExtension)、批量改名(rename)、
//       按内容哈希去重(dedupe)。目标路径自动加后缀避免冲突,最终经 previewFileOperations 出预览。
//       真正执行仍需走审批 apply(plan/01 C.11)。
// 依赖:L0 path-policy + 同层 file-operations。导出:planFileOrganization。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assertExternalWorkspacePath } from '../security/external-workspace-boundary.js';
import { previewFileOperations } from './file-operations.js';
import type { OperationPreview } from './file-operations.js';

export type OrganizeOptions = { trustedRoot?: string; files?: string[]; mode?: string; targetDir?: string; renamePrefix?: string };
export type OrganizeOperation = { type: 'move'; from: string; to: string } | { type: 'rename'; path: string; newName: string };
export type OrganizePlan = { operations: OrganizeOperation[]; preview: { operations: OperationPreview[] } };

function fileHash(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function safeFile(root: string, file: string): string {
  const full = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
  const safe = assertExternalWorkspacePath(full, root);
  if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) throw new Error(`file not found: ${file}`);
  return safe;
}

function safeTarget(root: string, targetDir: string | undefined, ...parts: string[]): string {
  return assertExternalWorkspacePath(path.join(root, String(targetDir || 'organized'), ...parts), root);
}

function targetWithSuffix(target: string, used: Set<string>): string {
  const parsed = path.parse(target);
  let current = target;
  let n = 2;
  while (used.has(current) || fs.existsSync(current)) {
    current = path.join(parsed.dir, `${parsed.name}-${n}${parsed.ext}`);
    n += 1;
  }
  used.add(current);
  return current;
}

/** 生成文件整理预案(byExtension/rename/dedupe 三种模式)+ 操作预览;不实际改动文件。 */
export function planFileOrganization({
  trustedRoot,
  files,
  mode = 'byExtension',
  targetDir = 'organized',
  renamePrefix = 'file',
}: OrganizeOptions = {}): OrganizePlan {
  if (!trustedRoot) throw new Error('trustedRoot is required');
  if (!Array.isArray(files) || files.length === 0) throw new Error('files must be a non-empty array');
  const root = path.resolve(trustedRoot);
  const safeFiles = files.map((file) => safeFile(root, file));
  const operations: OrganizeOperation[] = [];
  const usedTargets = new Set<string>();

  if (mode === 'dedupe') {
    const seen = new Map<string, string>();
    for (const file of safeFiles) {
      const hash = fileHash(file);
      if (!seen.has(hash)) {
        seen.set(hash, file);
        continue;
      }
      operations.push({ type: 'move', from: file, to: targetWithSuffix(safeTarget(root, targetDir, 'duplicates', path.basename(file)), usedTargets) });
    }
  } else if (mode === 'rename') {
    safeFiles.forEach((file, index) => {
      const ext = path.extname(file);
      operations.push({ type: 'rename', path: file, newName: `${String(renamePrefix || 'file').trim() || 'file'}-${index + 1}${ext}` });
    });
  } else if (mode === 'byExtension') {
    for (const file of safeFiles) {
      const ext = path.extname(file).replace(/^\./, '').toLowerCase() || 'no-extension';
      operations.push({ type: 'move', from: file, to: targetWithSuffix(safeTarget(root, targetDir, ext, path.basename(file)), usedTargets) });
    }
  } else {
    throw new Error(`unsupported organize mode: ${mode}`);
  }

  return { operations, preview: previewFileOperations(operations, { trustedRoot: root }) };
}
