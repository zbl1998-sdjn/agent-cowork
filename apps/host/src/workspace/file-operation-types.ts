// 工作区文件操作的类型契约(host · L1 领域层 · workspace)
// ---------------------------------------------------------------------------
// 职责:定义文件写/改名/移动等操作的输入、预览(含前后哈希)、执行选项与事件结构,
//       为 file-operation 提供统一契约,并衔接 file-rollback 的回滚记录。
import type { JournalWriter, RollbackEntry } from './file-rollback.js';

export type FileOperationInput = {
  type?: unknown;
  path?: string;
  from?: string;
  to?: string;
  newName?: string;
  content?: unknown;
  contentBase64?: string;
  encoding?: string;
  overwrite?: boolean;
};
export type FileOperation = FileOperationInput & { type: string };
export type OperationPreview = {
  type: 'write' | 'rename' | 'move';
  path: string;
  targetPath?: string;
  beforeHash: string | null;
  afterHash: string;
};
export type FileOperationOptions = {
  trustedRoot?: string;
  journalWriter?: JournalWriter;
  rollbackBatchId?: string;
};
export type FileOperationEvent = {
  id: string;
  at: string;
  action: string;
  path: string;
  targetPath?: string;
  beforeHash: string | null;
  afterHash: string;
  rollback?: RollbackEntry | null;
  status: string;
  size?: number;
};
