// Write/Edit 审批预览(host · L1 领域层 · engine)
// ---------------------------------------------------------------------------
// 职责:为 Write/Edit 两个写类工具构造 approvalPreview——Write 读磁盘上的旧内容
//       做 diff(读不到就按新文件处理,绝不抛出),Edit 直接用 old_string/new_string
//       做最小可信 diff;统一委托给 agent/approval-diff-preview 做安全截断/二进制探测。
// 依赖:node:fs + agent/approval-diff-preview + artifacts/artifact-access-guards(类型)。
import fs from 'node:fs';
import { buildApprovalDiffPreview, type ApprovalDiffPreview } from './agent/approval-diff-preview.js';
import type { ArtifactAccessGuards } from '../artifacts/artifact-access-guards.js';
import type { ToolArgs } from './agent-tools-types.js';

export function buildWriteApprovalPreview(artifactAccess: ArtifactAccessGuards, args: ToolArgs): ApprovalDiffPreview {
  const targetPath = String(args.path || '');
  const after = String(args.content ?? '');
  let before: string | null = null;
  // 仅用于审批展示的只读预览:读不到(新文件/越界/权限问题等)一律按"无旧内容"
  // 兜底,绝不能抛出——approval-gate 调用这里时没有 try/catch。
  try {
    before = fs.readFileSync(artifactAccess.readPath(targetPath), 'utf8');
  } catch { /* 按无旧内容处理 */ }
  return buildApprovalDiffPreview({ path: targetPath, before, after });
}

export function buildEditApprovalPreview(args: ToolArgs): ApprovalDiffPreview {
  // Edit 的改动本就是 old_string -> new_string 这一小段,直接拿它俩做预览即可,
  // 不必读整份文件——既是最小可信 diff,也避免大文件把审批卡片撑爆。
  return buildApprovalDiffPreview({
    path: String(args.path || ''),
    before: String(args.old_string ?? ''),
    after: String(args.new_string ?? ''),
  });
}
