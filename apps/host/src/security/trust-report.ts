// 信任报告(host L0 security).
// 职责:汇总本地模式、模型出站、审计和安全检查,生成可给企业/用户查看的本地证据。
import { readEgressAuditRecords, summariseEgressAudit } from './egress-audit.js';
import { MODEL_EGRESS_APPROVAL_CAPABILITY } from './model-egress-approval.js';
import { classifyModelProvider, decideModelProviderPolicy, resolveSecurityMode } from './security-mode.js';

export type TrustReport = {
  ok: boolean;
  generatedAt: string;
  securityMode: string;
  trustedRoot: string;
  model: {
    provider: string;
    model: string;
    providerClass: string;
    decision: string;
    reasonCode: string;
    approvalCapability: 'unavailable' | 'not_required';
  };
  egress: ReturnType<typeof summariseEgressAudit>;
  checks: Array<{ id: string; status: 'pass' | 'warn' | 'fail'; detail: string }>;
};

function clean(value: unknown): string {
  return String(value || '').trim();
}

export function buildTrustReport({
  trustedRoot,
  securityMode,
  modelConfig,
  sandboxNetworkIsolated,
}: {
  trustedRoot: unknown;
  securityMode?: unknown;
  modelConfig?: Record<string, unknown>;
  sandboxNetworkIsolated?: unknown;
}): TrustReport {
  const mode = resolveSecurityMode({ configuredMode: securityMode ?? modelConfig?.securityMode });
  const config = modelConfig || {};
  const policy = decideModelProviderPolicy(config, { securityMode: mode });
  const egress = summariseEgressAudit(readEgressAuditRecords(trustedRoot));
  const approvalPending = policy.decision === 'needs_approval';
  const checks: TrustReport['checks'] = [
    {
      id: 'local-model-policy',
      status: policy.decision === 'allow' ? 'pass' : (approvalPending ? 'warn' : 'fail'),
      detail: approvalPending
        ? `${policy.reasonCode}; approval capability unavailable (${MODEL_EGRESS_APPROVAL_CAPABILITY.reasonCode})`
        : policy.reasonCode,
    },
    {
      id: 'webfetch-local-strict',
      status: mode === 'local_strict' || mode === 'air_gap' || mode === 'local_demo' ? 'pass' : 'warn',
      detail: mode === 'controlled_hybrid' ? 'external network requires explicit preview/approval' : 'external web fetch is blocked by mode',
    },
    {
      id: 'egress-audit',
      status: 'pass',
      detail: `${egress.recordCount} records, ${egress.todayContentBytes} bytes today`,
    },
    {
      id: 'sandbox-network-isolation',
      status: sandboxNetworkIsolated === true ? 'pass' : 'warn',
      detail: sandboxNetworkIsolated === true ? 'sandbox network is isolated' : 'sandbox is not network-isolated on this host',
    },
  ];
  return {
    ok: !approvalPending && !checks.some((check) => check.status === 'fail'),
    generatedAt: new Date().toISOString(),
    securityMode: mode,
    trustedRoot: clean(trustedRoot),
    model: {
      provider: clean(config.provider || 'kimi-api'),
      model: clean(config.model),
      providerClass: classifyModelProvider(config),
      decision: policy.decision,
      reasonCode: policy.reasonCode,
      approvalCapability: approvalPending ? MODEL_EGRESS_APPROVAL_CAPABILITY.status : 'not_required',
    },
    egress,
    checks,
  };
}
