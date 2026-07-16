// 审批规则 API(UI · 传输层 · lib/api)
// ---------------------------------------------------------------------------
// 职责:列出/删除当前工作区的 always-allow 审批规则。新增只能经审批卡的
//       「本工作区总是允许」决定,不提供直加接口。
// 对应路由:/api/approval-rules、/api/approval-rules/:tool/remove。
import { getJson, postJson } from './transport';

function normalize(raw: { alwaysAllow?: unknown }): string[] {
  return Array.isArray(raw.alwaysAllow) ? raw.alwaysAllow.map((v) => String(v)).filter(Boolean) : [];
}

export async function getApprovalRules(): Promise<string[]> {
  return normalize(await getJson<{ alwaysAllow?: unknown }>('/api/approval-rules'));
}

export async function removeApprovalRule(tool: string): Promise<string[]> {
  return normalize(await postJson<{ alwaysAllow?: unknown }>(`/api/approval-rules/${encodeURIComponent(tool)}/remove`, {}));
}
