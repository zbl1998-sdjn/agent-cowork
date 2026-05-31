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
