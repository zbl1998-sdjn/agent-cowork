// 统一出站网关(host L0 security).
// 职责:对模型、WebFetch、连接器、插件下载、遥测等出站请求做统一策略判断。
import { buildOutboundPreview, type OutboundPreview, type OutboundPurpose } from './outbound-preview.js';
import {
  classifyModelProvider,
  decideModelProviderPolicy,
  resolveSecurityMode,
  type ProviderClass,
  type RuntimeEnv,
  type SecurityMode,
} from './security-mode.js';
import { writeEgressAuditRecord } from './egress-audit.js';
import type { EgressAuditDecision, EgressAuditRecord } from './egress-audit.js';

export type EgressDecision = {
  decision: EgressAuditDecision;
  allowed: boolean;
  securityMode: SecurityMode;
  providerClass: ProviderClass;
  reasonCode: string;
  reason: string;
  preview: OutboundPreview;
  audit: EgressAuditRecord;
};

export type EgressRequest = {
  kind: OutboundPurpose;
  destination?: unknown;
  provider?: unknown;
  model?: unknown;
  baseUrl?: unknown;
  content?: unknown;
  securityMode?: unknown;
  approved?: unknown;
  trustedRoot?: unknown;
  env?: RuntimeEnv;
};

function clean(value: unknown): string {
  return String(value || '').trim();
}

function randomId(): string {
  return `egress_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function isStrictLocalMode(mode: SecurityMode): boolean {
  return mode === 'local_demo' || mode === 'local_strict' || mode === 'air_gap';
}

function decisionForNonModel(kind: OutboundPurpose, mode: SecurityMode, approved: boolean): Pick<EgressDecision, 'decision' | 'reasonCode' | 'reason'> {
  if (mode === 'air_gap') {
    return { decision: 'deny', reasonCode: 'air_gap_blocks_all_egress', reason: 'air_gap blocks all network egress' };
  }
  if (isStrictLocalMode(mode) && (kind === 'web_fetch' || kind === 'connector' || kind === 'plugin_download')) {
    return { decision: 'deny', reasonCode: `${mode}_blocks_${kind}`, reason: `${mode} blocks ${kind}` };
  }
  if ((mode === 'enterprise_local' || mode === 'controlled_hybrid') && !approved && kind !== 'telemetry') {
    return { decision: 'needs_approval', reasonCode: `${mode}_${kind}_needs_approval`, reason: `${mode} requires approval before ${kind}` };
  }
  return { decision: 'allow', reasonCode: 'egress_allowed', reason: 'egress allowed by security mode' };
}

export function decideEgressPolicy(input: EgressRequest): EgressDecision {
  const env = input.env ?? process.env as RuntimeEnv;
  const config = {
    provider: input.provider,
    model: input.model,
    baseUrl: input.baseUrl ?? input.destination,
    securityMode: input.securityMode,
  };
  const mode = resolveSecurityMode({ configuredMode: input.securityMode, env });
  const providerClass = classifyModelProvider(config, { env });
  const approved = input.approved === true;
  const preview = buildOutboundPreview({
    purpose: input.kind,
    destination: input.destination ?? input.baseUrl,
    provider: input.provider,
    model: input.model,
    securityMode: mode,
    content: input.content,
  });
  const baseDecision = input.kind === 'model_inference'
    ? (() => {
      const policy = decideModelProviderPolicy(config, { securityMode: mode, env });
      if (policy.decision === 'needs_approval' && approved) {
        return { decision: 'allow' as const, reasonCode: 'approved_controlled_hybrid_model_egress', reason: 'external model egress was explicitly approved' };
      }
      return { decision: policy.decision, reasonCode: policy.reasonCode, reason: policy.reason };
    })()
    : decisionForNonModel(input.kind, mode, approved);
  const audit: EgressAuditRecord = {
    id: randomId(),
    timestamp: new Date().toISOString(),
    kind: input.kind,
    decision: baseDecision.decision,
    reasonCode: baseDecision.reasonCode,
    securityMode: mode,
    destination: clean(input.destination ?? input.baseUrl),
    provider: clean(input.provider),
    model: clean(input.model),
    contentBytes: preview.contentBytes,
    sensitivity: preview.classification.sensitivity,
    tags: preview.classification.tags.map((tag) => tag.kind),
    approved,
    redactedPreview: preview.redactedPreview,
  };
  return {
    ...baseDecision,
    allowed: baseDecision.decision !== 'deny',
    securityMode: mode,
    providerClass,
    preview,
    audit,
  };
}

export function recordEgressDecision(trustedRoot: unknown, decision: EgressDecision): string {
  return writeEgressAuditRecord(trustedRoot, decision.audit);
}

export function egressPolicyError(decision: EgressDecision): Error & { code: string; egressDecision: EgressDecision } {
  const error = new Error(`egress blocked by ${decision.securityMode}: ${decision.reason}`) as Error & {
    code: string;
    egressDecision: EgressDecision;
  };
  error.name = 'EgressPolicyError';
  error.code = decision.decision === 'needs_approval' ? 'EGRESS_APPROVAL_REQUIRED' : 'EGRESS_POLICY_DENIED';
  error.egressDecision = decision;
  return error;
}

