// 出站预览(host L0 security).
// 职责:生成“将外发什么”的脱敏预览,供 UI/审计/策略共同使用。
import { classifyData, type DataClassification } from './data-classifier.js';
import { redactText } from './redaction.js';
import { resolveSecurityMode, type SecurityMode } from './security-mode.js';

export type OutboundPurpose = 'model_inference' | 'web_fetch' | 'telemetry' | 'connector' | 'plugin_download';

export type OutboundPreview = {
  purpose: OutboundPurpose;
  destination: string;
  provider: string;
  model: string;
  securityMode: SecurityMode;
  contentBytes: number;
  redactedPreview: string;
  classification: DataClassification;
  requiresUserPreview: boolean;
};

function serialiseContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function buildOutboundPreview({
  purpose,
  destination,
  provider,
  model,
  securityMode,
  content,
}: {
  purpose: OutboundPurpose;
  destination?: unknown;
  provider?: unknown;
  model?: unknown;
  securityMode?: unknown;
  content?: unknown;
}): OutboundPreview {
  const mode = resolveSecurityMode({ configuredMode: securityMode });
  const text = serialiseContent(content);
  const redacted = String(redactText(text) || '');
  const classification = classifyData({ text });
  return {
    purpose,
    destination: String(destination || '').trim(),
    provider: String(provider || '').trim().toLowerCase(),
    model: String(model || '').trim(),
    securityMode: mode,
    contentBytes: Buffer.byteLength(text, 'utf8'),
    redactedPreview: redacted.slice(0, 1200),
    classification,
    requiresUserPreview: purpose !== 'telemetry' && !classification.allowCloudByDefault,
  };
}

