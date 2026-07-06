// Unified tool policy decision (host L0 security).

import { resolveSecurityMode, type RuntimeEnv, type SecurityMode } from './security-mode.js';

export type PolicyDecisionValue = 'allow' | 'deny' | 'needs_approval';
export type ToolRiskLevel = 'read_workspace' | 'write_workspace' | 'sandbox_exec' | 'network_external' | 'connector' | 'unknown';

export type ToolPolicyInput = {
  toolName: string;
  risk?: unknown;
  mutating?: unknown;
  requiresApproval?: unknown;
  securityMode?: unknown;
  sandbox?: unknown;
  env?: RuntimeEnv;
};

export type PolicyDecision = {
  decision: PolicyDecisionValue;
  securityMode: SecurityMode;
  toolName: string;
  riskLevel: ToolRiskLevel;
  reasonCode: string;
  reason: string;
  audit: {
    decision: PolicyDecisionValue;
    securityMode: SecurityMode;
    toolName: string;
    riskLevel: ToolRiskLevel;
    reasonCode: string;
    sandboxNetworkIsolated: boolean;
  };
};

function lower(value: unknown): string {
  return String(value || '').trim().toLowerCase();
}

function sandboxNetworkIsolated(sandbox: unknown): boolean {
  return Boolean(sandbox && typeof sandbox === 'object' && (sandbox as { networkIsolated?: unknown }).networkIsolated === true);
}

export function classifyToolRisk(input: Pick<ToolPolicyInput, 'toolName' | 'risk' | 'mutating'>): ToolRiskLevel {
  const name = lower(input.toolName);
  const risk = lower(input.risk);
  // 联网工具:web.fetch 与 WebSearch(及带前缀/分隔符变体)都归为对外网络,
  // 好让 local_demo/local_strict/air_gap 统一拦截。compact 去掉点/下划线/连字符后
  // 等价比较,修此前只匹配 web.fetch 家族、漏掉实际工具名 WebSearch(会在 air_gap
  // “零外发”下仍打 DuckDuckGo/Bing)的缺口。
  const compact = name.replace(/[^a-z0-9]/gu, '');
  if (compact === 'webfetch' || compact === 'websearch' || name.includes('webfetch') || name.includes('websearch')) {
    return 'network_external';
  }
  if (name === 'shell' || name === 'sandbox.exec' || name === 'sandbox.run-code' || name.includes('run-code')) {
    return 'sandbox_exec';
  }
  if (name.startsWith('mcp__') || name.includes('oauth') || name.includes('connector')) {
    return 'connector';
  }
  if (input.mutating === true || name === 'write' || name === 'edit' || name === 'gitcommit' || risk === 'high' || risk === 'critical') {
    return 'write_workspace';
  }
  if (name === 'read' || name === 'glob' || name === 'grep' || name === 'searchworkspace' || name.startsWith('git')) {
    return 'read_workspace';
  }
  return 'unknown';
}

function approvalLike(input: ToolPolicyInput, riskLevel: ToolRiskLevel): boolean {
  const risk = lower(input.risk);
  return input.requiresApproval === true
    || input.mutating === true
    || risk === 'high'
    || risk === 'critical'
    || riskLevel === 'connector';
}

export function decideToolPolicy(input: ToolPolicyInput): PolicyDecision {
  const env = input.env ?? process.env as RuntimeEnv;
  const mode = resolveSecurityMode({ configuredMode: input.securityMode, env });
  const riskLevel = classifyToolRisk(input);
  const isolated = sandboxNetworkIsolated(input.sandbox);
  let decision: PolicyDecisionValue = 'allow';
  let reasonCode = 'tool_policy_allowed';
  let reason = 'tool allowed by security mode';

  if ((mode === 'local_demo' || mode === 'local_strict' || mode === 'air_gap') && riskLevel === 'network_external') {
    decision = 'deny';
    reasonCode = `${mode}_blocks_external_network_tool`;
    reason = `${mode} blocks external network tools`;
  } else if ((mode === 'local_strict' || mode === 'air_gap') && riskLevel === 'sandbox_exec' && !isolated) {
    decision = 'deny';
    reasonCode = `${mode}_requires_isolated_sandbox`;
    reason = `${mode} requires a network-isolated VM/Docker sandbox for execution tools`;
  } else if (mode === 'enterprise_local' && riskLevel === 'network_external') {
    decision = 'needs_approval';
    reasonCode = 'enterprise_local_external_tool_needs_approval';
    reason = 'enterprise_local requires approval for external network tools';
  } else if (approvalLike(input, riskLevel)) {
    decision = 'needs_approval';
    reasonCode = 'tool_requires_approval';
    reason = 'tool risk or mutation requires approval';
  }

  return {
    decision,
    securityMode: mode,
    toolName: input.toolName,
    riskLevel,
    reasonCode,
    reason,
    audit: {
      decision,
      securityMode: mode,
      toolName: input.toolName,
      riskLevel,
      reasonCode,
      sandboxNetworkIsolated: isolated,
    },
  };
}
