// 会话 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:封装会话的列出/搜索/读取/保存/删除,统一吞错返回空集或布尔结果。
// 依赖/对应路由:GET /api/conversations(?full|?q)、GET/PUT/DELETE /api/conversations/:id。导出:listStoredConversations / searchStoredConversations / getStoredConversation / saveStoredConversation / deleteStoredConversation + 相关类型。
import { getJson, sendJsonMethod } from './transport';

export interface StoredConversation {
  id: string;
  title: string;
  pinned?: boolean | undefined;
  messages: unknown[];
  activeBranchId?: string | undefined;
  branches?: unknown[] | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
}

export interface ConversationSummary {
  id: string;
  title: string;
  pinned?: boolean | undefined;
  activeBranchId?: string | undefined;
  branchCount?: number | undefined;
  messageCount?: number | undefined;
  createdAt?: string | undefined;
  updatedAt?: string | undefined;
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
  data: {
    title?: string | undefined;
    pinned?: boolean | undefined;
    messages?: unknown[] | undefined;
    activeBranchId?: string | undefined;
    branches?: unknown[] | undefined;
  },
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
