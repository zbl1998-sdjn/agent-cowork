import { getJson, sendJsonMethod } from './transport';

export interface StoredConversation {
  id: string;
  title: string;
  pinned?: boolean;
  messages: unknown[];
  activeBranchId?: string;
  branches?: unknown[];
  createdAt?: string;
  updatedAt?: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  pinned?: boolean;
  activeBranchId?: string;
  branchCount?: number;
  messageCount?: number;
  createdAt?: string;
  updatedAt?: string;
}

export async function listStoredConversations(limit = 50): Promise<StoredConversation[]> {
  try {
    const res = await getJson<{ conversations: StoredConversation[] }>(`/api/conversations?full=1&limit=${limit}`);
    return Array.isArray(res.conversations) ? res.conversations : [];
  } catch {
    return [];
  }
}

export async function searchStoredConversations(
  q: string,
  limit = 20,
  offset = 0,
): Promise<{ items: ConversationSummary[]; total: number }> {
  try {
    const res = await getJson<{ conversations: ConversationSummary[]; total?: number }>(
      `/api/conversations?q=${encodeURIComponent(q)}&limit=${limit}&offset=${offset}`,
    );
    return { items: res.conversations || [], total: res.total || 0 };
  } catch {
    return { items: [], total: 0 };
  }
}

export async function getStoredConversation(id: string): Promise<StoredConversation | null> {
  try {
    const res = await getJson<{ conversation: StoredConversation }>(`/api/conversations/${encodeURIComponent(id)}`);
    return res.conversation || null;
  } catch {
    return null;
  }
}

export async function saveStoredConversation(
  id: string,
  data: { title?: string; pinned?: boolean; messages?: unknown[]; activeBranchId?: string; branches?: unknown[] },
): Promise<boolean> {
  try {
    await sendJsonMethod('PUT', `/api/conversations/${encodeURIComponent(id)}`, data);
    return true;
  } catch {
    return false;
  }
}

export async function deleteStoredConversation(id: string): Promise<boolean> {
  try {
    const res = await sendJsonMethod<{ deleted?: boolean }>('DELETE', `/api/conversations/${encodeURIComponent(id)}`);
    return Boolean(res.deleted);
  } catch {
    return false;
  }
}
