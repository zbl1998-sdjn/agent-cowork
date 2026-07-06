// 出站审计(host L0 security).
// 职责:把出站决策写入工作区本地 JSONL,只保存元数据和脱敏摘要。
import fs from 'node:fs';
import path from 'node:path';
import { assertTrustedPath } from './path-policy.js';
import { redactValue } from './redaction.js';
import type { DataSensitivity, DataTagKind } from './data-classifier.js';
import type { SecurityMode } from './security-mode.js';

export type EgressAuditDecision = 'allow' | 'deny' | 'needs_approval';
export type EgressAuditRecord = {
  id: string;
  timestamp: string;
  kind: string;
  decision: EgressAuditDecision;
  reasonCode: string;
  securityMode: SecurityMode;
  destination: string;
  provider?: string;
  model?: string;
  contentBytes: number;
  sensitivity: DataSensitivity;
  tags: DataTagKind[];
  approved: boolean;
  redactedPreview?: string;
};

export type EgressAuditSummary = {
  recordCount: number;
  todayContentBytes: number;
  todayExternalModelCalls: number;
  deniedCount: number;
  needsApprovalCount: number;
  byDecision: Record<EgressAuditDecision, number>;
  byKind: Record<string, number>;
  lastRecordAt: string | null;
};

function cleanRoot(value: unknown): string {
  return path.resolve(String(value || process.cwd()));
}

export function egressAuditPath(trustedRoot: unknown): string {
  const root = cleanRoot(trustedRoot);
  const file = path.join(root, '.AgentCowork', 'security', 'egress-audit.jsonl');
  assertTrustedPath(file, root);
  return file;
}

export function writeEgressAuditRecord(trustedRoot: unknown, record: EgressAuditRecord): string {
  const file = egressAuditPath(trustedRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(redactValue(record))}\n`, 'utf8');
  return file;
}

export function readEgressAuditRecords(trustedRoot: unknown): EgressAuditRecord[] {
  const file = egressAuditPath(trustedRoot);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as EgressAuditRecord;
        return parsed && typeof parsed === 'object' ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

function isLocalDestination(record: EgressAuditRecord): boolean {
  const provider = String(record.provider || '').toLowerCase();
  const destination = String(record.destination || '').toLowerCase();
  return provider === 'ollama'
    || provider === 'openai/local'
    || provider === 'lmstudio'
    || destination.includes('127.0.0.1')
    || destination.includes('localhost');
}

function isActualExternalEgress(record: EgressAuditRecord): boolean {
  return record.decision === 'allow' && !isLocalDestination(record);
}

export function summariseEgressAudit(records: readonly EgressAuditRecord[], now = new Date()): EgressAuditSummary {
  const today = now.toISOString().slice(0, 10);
  const byDecision: Record<EgressAuditDecision, number> = { allow: 0, deny: 0, needs_approval: 0 };
  const byKind: Record<string, number> = {};
  let todayContentBytes = 0;
  let todayExternalModelCalls = 0;
  let lastRecordAt: string | null = null;
  for (const record of records) {
    byDecision[record.decision] = (byDecision[record.decision] || 0) + 1;
    byKind[record.kind] = (byKind[record.kind] || 0) + 1;
    if (!lastRecordAt || record.timestamp > lastRecordAt) lastRecordAt = record.timestamp;
    if (String(record.timestamp || '').slice(0, 10) === today) {
      if (isActualExternalEgress(record)) todayContentBytes += Number(record.contentBytes || 0);
      if (record.kind === 'model_inference' && isActualExternalEgress(record)) {
        todayExternalModelCalls += 1;
      }
    }
  }
  return {
    recordCount: records.length,
    todayContentBytes,
    todayExternalModelCalls,
    deniedCount: byDecision.deny,
    needsApprovalCount: byDecision.needs_approval,
    byDecision,
    byKind,
    lastRecordAt,
  };
}
