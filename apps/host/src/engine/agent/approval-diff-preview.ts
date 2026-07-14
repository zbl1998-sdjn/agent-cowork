// 审批 diff 预览(host · L1 领域层 · engine/agent)
// ---------------------------------------------------------------------------
// 职责:把一次文件写入的 before/after 文本安全地整理成可下发给 UI 的 diff 预览——
//       含 NUL 字节的按二进制处理(只报字节数,不下发内容),超长文本按 clip() 截断,
//       避免整份大文件/二进制内容被塞进审批卡片或 SSE 事件。纯函数,无 IO。
// 依赖:./agent-tools-support 的 clip()。
import { clip } from '../agent-tools-support.js';

export type ApprovalDiffPreview =
  | { kind: 'text'; path: string; before: string | null; after: string }
  | { kind: 'binary'; path: string; beforeBytes: number | null; afterBytes: number };

const NUL = String.fromCharCode(0);

function isBinary(value: string): boolean {
  return value.includes(NUL);
}

export function buildApprovalDiffPreview(input: { path: string; before: string | null; after: string }): ApprovalDiffPreview {
  const { path: targetPath, before, after } = input;
  if ((before !== null && isBinary(before)) || isBinary(after)) {
    return {
      kind: 'binary',
      path: targetPath,
      beforeBytes: before === null ? null : Buffer.byteLength(before, 'utf8'),
      afterBytes: Buffer.byteLength(after, 'utf8'),
    };
  }
  return {
    kind: 'text',
    path: targetPath,
    before: before === null ? null : clip(before),
    after: clip(after),
  };
}
