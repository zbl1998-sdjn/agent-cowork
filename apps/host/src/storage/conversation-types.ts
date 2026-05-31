export type ConversationContext = { tenantId?: unknown; userId?: unknown };
export type ConversationBranch = {
  id: string;
  title: string;
  parentBranchId?: string;
  baseMessageId?: string;
  createdAt?: string;
  messages: unknown[];
};
export type ConversationInput = {
  id?: unknown;
  title?: unknown;
  pinned?: unknown;
  messages?: unknown;
  activeBranchId?: unknown;
  branches?: unknown;
  createdAt?: unknown;
  updatedAt?: unknown;
};
export type ConversationRecord = {
  id: string;
  title: string;
  pinned: boolean;
  messages: unknown[];
  activeBranchId?: string;
  branches?: ConversationBranch[];
  createdAt?: unknown;
  updatedAt?: unknown;
};
export type ConversationSummary = {
  id: string;
  title: string;
  pinned: boolean;
  messageCount: number;
  branchCount: number;
  activeBranchId?: string;
  createdAt?: unknown;
  updatedAt?: unknown;
};
export type ConversationQueryOptions = { q?: unknown; limit?: unknown; offset?: unknown };
export type ConversationQueryResult = { items: ConversationSummary[]; total: number };
export type ConversationListFullOptions = { limit?: number };
export type ConversationStoreOptions = { backend?: string; now?: () => Date };
