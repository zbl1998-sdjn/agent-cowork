// 工作区级审批放行规则(host · L2 运行时层 · runtime)
// ---------------------------------------------------------------------------
// 职责:持久化"本工作区总是允许"的工具名单——`.AgentCowork/settings/approval-rules.json`。
//       仅适用于非显式审批工具(requiresApproval/high/critical 永远逐次审批,门禁侧兜底);
//       规则由用户在审批卡上显式选择才写入。文件缺失/损坏安全降级为空名单。
// 依赖:node:fs / node:path。导出:createWorkspaceApprovalRules、WorkspaceApprovalRules。
import fs from 'node:fs';
import path from 'node:path';

export type WorkspaceApprovalRules = {
  has(name: string): boolean;
  add(name: string): void;
  list(): string[];
};

// 工具名白名单形状:内置工具(Write/Edit/Shell)与 mcp__server__tool 命名都覆盖。
const TOOL_NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

function rulesPath(trustedRoot: string): string {
  return path.join(path.resolve(trustedRoot), '.AgentCowork', 'settings', 'approval-rules.json');
}

function readRules(trustedRoot: string): Set<string> {
  try {
    const raw = JSON.parse(fs.readFileSync(rulesPath(trustedRoot), 'utf8')) as { alwaysAllow?: unknown };
    const list = Array.isArray(raw?.alwaysAllow) ? raw.alwaysAllow : [];
    return new Set(list.filter((name): name is string => typeof name === 'string' && TOOL_NAME_RE.test(name)));
  } catch {
    return new Set();
  }
}

function persistRules(trustedRoot: string, merged: Set<string>): string[] {
  const sorted = [...merged].sort();
  const file = rulesPath(trustedRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ alwaysAllow: sorted, updatedAt: new Date().toISOString() }, null, 2) + '\n', 'utf8');
  return sorted;
}

/** 列出本工作区已持久化的 always-allow 工具名(排序后)。 */
export function listWorkspaceApprovalRules(trustedRoot: string): string[] {
  return [...readRules(trustedRoot)].sort();
}

/** 删除一条 always-allow 规则并落盘;返回删除后的名单。非法/不存在的名字为幂等 no-op。 */
export function removeWorkspaceApprovalRule(trustedRoot: string, name: string): string[] {
  const merged = readRules(trustedRoot);
  merged.delete(name);
  return persistRules(trustedRoot, merged);
}

/** 按工作区创建规则快照:has 用创建时名单 + 本进程内新增;add 读改写落盘(非法名忽略)。 */
export function createWorkspaceApprovalRules(trustedRoot: string): WorkspaceApprovalRules {
  const names = readRules(trustedRoot);
  return {
    has(name) {
      return names.has(name);
    },
    add(name) {
      if (!TOOL_NAME_RE.test(name)) return;
      const merged = readRules(trustedRoot);
      merged.add(name);
      names.add(name);
      persistRules(trustedRoot, merged);
    },
    list() {
      return [...names].sort();
    },
  };
}
