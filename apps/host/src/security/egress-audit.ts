// 出站审计(host L0 security).
// 职责:把出站决策写入工作区本地 JSONL,只保存元数据和脱敏摘要。
import path from 'node:path';
import { assertTrustedPathForCreate } from './path-policy.js';
import { redactValue } from './redaction.js';
import { isLocalEgressDestination } from './egress-destination.js';
import { createManagedDirectoryBoundary } from './managed-directory-boundary.js';
import { appendPrivateManagedFile, readPrivateManagedFile } from './managed-private-file.js';
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
const DECISIONS = new Set<EgressAuditDecision>(['allow', 'deny', 'needs_approval']);
const SECURITY_MODE_VALUES = new Set<SecurityMode>([
  'local_demo',
  'local_strict',
  'enterprise_local',
  'air_gap',
  'controlled_hybrid',
]);
const SENSITIVITY_VALUES = new Set<DataSensitivity>(['public', 'internal', 'confidential', 'restricted']);
const TAG_VALUES = new Set<DataTagKind>([
  'credential_secret',
  'personal_information',
  'financial',
  'hr',
  'customer_data',
  'source_code',
  'contract',
  'legal',
  'strategy',
  'meeting',
  'unknown',
]);

export class EgressAuditIntegrityError extends Error {
  readonly code = 'EGRESS_AUDIT_INTEGRITY_ERROR';
  readonly statusCode = 500;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'EgressAuditIntegrityError';
    if (typeof cause !== 'undefined') (this as Error & { cause?: unknown }).cause = cause;
  }
}

function cleanRoot(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('trustedRoot is required for egress audit');
  }
  return path.resolve(value.trim());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  if (typeof value === 'undefined') return undefined;
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  return value;
}

function validateEgressAuditRecord(value: unknown): EgressAuditRecord {
  if (!isRecord(value)) throw new TypeError('record must be an object');
  const decision = requiredString(value, 'decision') as EgressAuditDecision;
  const securityMode = requiredString(value, 'securityMode') as SecurityMode;
  const sensitivity = requiredString(value, 'sensitivity') as DataSensitivity;
  if (!DECISIONS.has(decision)) throw new TypeError('decision is invalid');
  if (!SECURITY_MODE_VALUES.has(securityMode)) throw new TypeError('securityMode is invalid');
  if (!SENSITIVITY_VALUES.has(sensitivity)) throw new TypeError('sensitivity is invalid');
  if (!Array.isArray(value.tags) || !value.tags.every((tag) => typeof tag === 'string' && TAG_VALUES.has(tag as DataTagKind))) {
    throw new TypeError('tags are invalid');
  }
  const contentBytes = value.contentBytes;
  if (typeof contentBytes !== 'number' || !Number.isFinite(contentBytes) || contentBytes < 0) {
    throw new TypeError('contentBytes must be a non-negative finite number');
  }
  if (typeof value.approved !== 'boolean') throw new TypeError('approved must be a boolean');
  const timestamp = requiredString(value, 'timestamp');
  if (!Number.isFinite(Date.parse(timestamp))) throw new TypeError('timestamp is invalid');
  const record: EgressAuditRecord = {
    id: requiredString(value, 'id'),
    timestamp,
    kind: requiredString(value, 'kind'),
    decision,
    reasonCode: requiredString(value, 'reasonCode'),
    securityMode,
    destination: typeof value.destination === 'string' ? value.destination : (() => { throw new TypeError('destination must be a string'); })(),
    contentBytes,
    sensitivity,
    tags: value.tags as DataTagKind[],
    approved: value.approved,
  };
  const provider = optionalString(value, 'provider');
  const model = optionalString(value, 'model');
  const redactedPreview = optionalString(value, 'redactedPreview');
  if (typeof provider !== 'undefined') record.provider = provider;
  if (typeof model !== 'undefined') record.model = model;
  if (typeof redactedPreview !== 'undefined') record.redactedPreview = redactedPreview;
  return record;
}

export function egressAuditPath(trustedRoot: unknown): string {
  const root = cleanRoot(trustedRoot);
  const file = path.join(root, '.AgentCowork', 'security', 'egress-audit.jsonl');
  return assertTrustedPathForCreate(file, root);
}

export function writeEgressAuditRecord(trustedRoot: unknown, record: EgressAuditRecord): string {
  const root = cleanRoot(trustedRoot);
  let file = egressAuditPath(root);
  const boundary = createManagedDirectoryBoundary(path.dirname(file), {
    create: true,
    label: 'Egress audit directory',
  });
  file = assertTrustedPathForCreate(file, root);
  const safeRecord = validateEgressAuditRecord(redactValue(validateEgressAuditRecord(record)));
  appendPrivateManagedFile(boundary, file, `${JSON.stringify(safeRecord)}\n`);
  return file;
}

export function readEgressAuditRecords(trustedRoot: unknown): EgressAuditRecord[] {
  const root = cleanRoot(trustedRoot);
  const candidate = egressAuditPath(root);
  const boundary = createManagedDirectoryBoundary(root, {
    create: false,
    label: 'Egress audit trusted root',
  });
  const contents = readPrivateManagedFile(boundary, candidate);
  if (contents === null) return [];
  const records: EgressAuditRecord[] = [];
  for (const [index, line] of contents.split(/\r?\n/g).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(validateEgressAuditRecord(JSON.parse(line) as unknown));
    } catch (cause) {
      throw new EgressAuditIntegrityError(`egress audit record ${index + 1} is invalid`, cause);
    }
  }
  return records;
}

function isActualExternalEgress(record: EgressAuditRecord): boolean {
  return record.decision === 'allow'
    && !isLocalEgressDestination(record.destination, record.provider);
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
