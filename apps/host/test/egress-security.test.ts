import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { classifyData } from '../src/security/data-classifier.js';
import { decideEgressPolicy, recordEgressDecision } from '../src/security/egress-gateway.js';
import { readEgressAuditRecords, summariseEgressAudit } from '../src/security/egress-audit.js';
import { buildOutboundPreview } from '../src/security/outbound-preview.js';
import { buildTrustReport } from '../src/security/trust-report.js';
import { decideMemoryDlp } from '../src/memory/memory-dlp-guard.js';
import type { EgressAuditRecord } from '../src/security/egress-audit.js';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kcw-egress-'));
}

test('data classifier tags secrets without returning raw content', () => {
  const result = classifyData({ text: 'api_key=sk-test-secret-1234567890 payroll customer list' });
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
