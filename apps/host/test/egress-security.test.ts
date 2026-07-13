import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyData } from '../src/security/data-classifier.js';
import {
  decideEgressPolicy,
  egressPolicyError,
  enforceRecordedEgressDecision,
  isEgressAuditFailure,
  recordEgressDecision,
} from '../src/security/egress-gateway.js';
import { readEgressAuditRecords, summariseEgressAudit } from '../src/security/egress-audit.js';
import { buildOutboundPreview } from '../src/security/outbound-preview.js';
import { buildTrustReport } from '../src/security/trust-report.js';
import { decideMemoryDlp } from '../src/memory/memory-dlp-guard.js';
import type { EgressAuditRecord } from '../src/security/egress-audit.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-'));
}

test('data classifier tags secrets without returning raw content', () => {
  const result = classifyData({ text: 'api_key=sk-test-dummy-0000000000 payroll customer list' });
  assert.equal(result.sensitivity, 'restricted');
  assert.ok(result.tags.some((tag) => tag.kind === 'credential_secret'));
  assert.equal(result.allowCloudByDefault, false);
});

test('outbound preview redacts secrets before display', () => {
  const preview = buildOutboundPreview({
    purpose: 'model_inference',
    destination: 'https://api.moonshot.ai/v1',
    provider: 'kimi-api',
    model: 'kimi-k2.7-code',
    securityMode: 'local_strict',
    content: 'Bearer sk-test-preview-secret-1234567890',
  });

  assert.ok(preview.redactedPreview.includes('[REDACTED]'));
  assert.ok(!preview.redactedPreview.includes('sk-test-preview-secret'));
});

test('egress gateway blocks cloud model and web fetch in local strict, while allowing Ollama', () => {
  const cloud = decideEgressPolicy({
    kind: 'model_inference',
    provider: 'kimi-api',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.7-code',
    securityMode: 'local_strict',
    content: 'secret customer data',
  });
  assert.equal(cloud.decision, 'deny');

  const local = decideEgressPolicy({
    kind: 'model_inference',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:0.5b',
    securityMode: 'local_strict',
    content: 'local prompt',
  });
  assert.equal(local.decision, 'allow');

  const web = decideEgressPolicy({
    kind: 'web_fetch',
    destination: 'https://example.com',
    securityMode: 'local_strict',
  });
  assert.equal(web.decision, 'deny');
});

test('controlled hybrid model egress is fail-closed until approval has been validated', () => {
  const pending = decideEgressPolicy({
    kind: 'model_inference',
    provider: 'kimi-api',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.7-code',
    securityMode: 'controlled_hybrid',
    content: 'customer prompt',
  });
  assert.equal(pending.decision, 'needs_approval');
  assert.equal(pending.allowed, false);
  assert.equal(egressPolicyError(pending).code, 'EGRESS_APPROVAL_REQUIRED');

  const forgedBoolean = decideEgressPolicy({
    kind: 'model_inference',
    provider: 'kimi-api',
    baseUrl: 'https://api.moonshot.ai/v1',
    model: 'kimi-k2.7-code',
    securityMode: 'controlled_hybrid',
    approved: true,
  });
  assert.equal(forgedBoolean.decision, 'needs_approval');
  assert.equal(forgedBoolean.allowed, false);
  assert.equal(forgedBoolean.audit.approved, false);
});

test('egress audit and trust report summarize local evidence', () => {
  const trustedRoot = tempRoot();
  const decision = decideEgressPolicy({
    kind: 'model_inference',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen2.5:0.5b',
    securityMode: 'local_strict',
    content: 'local prompt',
  });
  recordEgressDecision(trustedRoot, decision);

  const records = readEgressAuditRecords(trustedRoot);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.provider, 'ollama');

  const report = buildTrustReport({
    trustedRoot,
    securityMode: 'local_strict',
    modelConfig: { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:0.5b' },
  });
  assert.equal(report.ok, true);
  assert.equal(report.egress.recordCount, 1);
});

test('trust report marks pending model approval as unavailable and not overall ok', () => {
  const report = buildTrustReport({
    trustedRoot: tempRoot(),
    securityMode: 'controlled_hybrid',
    modelConfig: {
      provider: 'kimi-api',
      baseUrl: 'https://api.moonshot.ai/v1',
      model: 'kimi-k2.7-code',
    },
  });

  const modelPolicy = report.checks.find((check) => check.id === 'local-model-policy');
  assert.equal(report.model.decision, 'needs_approval');
  assert.equal(report.model.approvalCapability, 'unavailable');
  assert.equal(modelPolicy?.status, 'warn');
  assert.match(modelPolicy?.detail || '', /unavailable/i);
  assert.equal(report.ok, false);
});

test('egress summary counts only allowed non-local content as actual outbound bytes', () => {
  const today = new Date('2026-07-03T10:00:00.000Z');
  const records: EgressAuditRecord[] = [
    {
      id: 'denied-cloud',
      timestamp: '2026-07-03T09:00:00.000Z',
      kind: 'model_inference',
      decision: 'deny',
      reasonCode: 'local_strict_model_must_be_local',
      securityMode: 'local_strict',
      destination: 'https://api.moonshot.ai/v1',
      provider: 'kimi-api',
      model: 'kimi-k2.7-code',
      contentBytes: 99,
      sensitivity: 'restricted',
      tags: [],
      approved: false,
    },
    {
      id: 'local-ollama',
      timestamp: '2026-07-03T09:01:00.000Z',
      kind: 'model_inference',
      decision: 'allow',
      reasonCode: 'model_provider_allowed',
      securityMode: 'local_strict',
      destination: 'http://127.0.0.1:11434/v1',
      provider: 'ollama',
      model: 'qwen2.5:0.5b',
      contentBytes: 88,
      sensitivity: 'internal',
      tags: [],
      approved: true,
    },
  ];

  const summary = summariseEgressAudit(records, today);
  assert.equal(summary.todayContentBytes, 0);
  assert.equal(summary.todayExternalModelCalls, 0);
  assert.equal(summary.deniedCount, 1);
});

test('memory DLP denies credentials before long-term write', () => {
  const decision = decideMemoryDlp({
    title: 'token',
    content: 'Authorization: Bearer sk-test-memory-secret-1234567890',
  });

  assert.equal(decision.action, 'deny_write');
  assert.equal(decision.sensitivity, 'secret');
});

test('memory DLP denies bare credential shapes recognized by redaction while allowing ordinary dotted text', () => {
  for (const content of [
    'sampleheader.samplepayload.samplesignature',
    'sampleopaquevalue1234567890.sampleopaquevalue0987654321',
  ]) {
    const classification = classifyData({ text: content });
    assert.equal(classification.redactionApplied, true, `${content} should be recognized by redaction`);
    assert.equal(decideMemoryDlp({ content }).action, 'deny_write');
  }

  assert.equal(decideMemoryDlp({ content: '版本是 1.2.3' }).action, 'allow_auto_write');
});

test('egress audit rejects a malformed middle record instead of undercounting evidence', () => {
  const trustedRoot = tempRoot();
  const first = decideEgressPolicy({
    kind: 'model_inference',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'local-one',
    securityMode: 'local_strict',
  }).audit;
  const second = { ...first, id: 'second', model: 'local-two' };
  const file = path.join(trustedRoot, '.AgentCowork', 'security', 'egress-audit.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(first)}\n{"broken":\n${JSON.stringify(second)}\n`, 'utf8');

  assert.throws(() => readEgressAuditRecords(trustedRoot), /egress audit.*(?:integrity|invalid)/i);
});

test('egress enforcement fails closed when its required audit sink is unavailable', () => {
  const trustedRoot = tempRoot();
  fs.writeFileSync(path.join(trustedRoot, '.AgentCowork'), 'blocks audit directory', 'utf8');
  const allowed = decideEgressPolicy({
    kind: 'model_inference',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'local-model',
    securityMode: 'local_strict',
  });

  assert.throws(
    () => enforceRecordedEgressDecision(trustedRoot, allowed),
    (error: unknown) => isEgressAuditFailure(error)
      && (error as { code?: unknown }).code === 'EGRESS_AUDIT_FAILED',
  );
});

test('denied egress preserves its policy code when audit persistence also fails', () => {
  const trustedRoot = tempRoot();
  fs.writeFileSync(path.join(trustedRoot, '.AgentCowork'), 'blocks audit directory', 'utf8');
  const denied = decideEgressPolicy({
    kind: 'web_fetch',
    destination: 'https://example.com',
    securityMode: 'local_strict',
  });

  assert.throws(
    () => enforceRecordedEgressDecision(trustedRoot, denied),
    (error: unknown) => {
      const failure = error as { code?: unknown; auditFailure?: { code?: unknown } };
      return failure.code === 'EGRESS_POLICY_DENIED'
        && failure.auditFailure?.code === 'EGRESS_AUDIT_FAILED'
        && !Object.keys(failure).includes('auditFailure');
    },
  );
});
