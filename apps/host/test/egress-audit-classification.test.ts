import assert from 'node:assert/strict';
import test from 'node:test';

import { summariseEgressAudit, type EgressAuditRecord } from '../src/security/egress-audit.js';

const timestamp = '2026-07-11T01:00:00.000Z';

function allowedModel(
  id: string,
  destination: string,
  contentBytes: number,
  provider = 'openai',
): EgressAuditRecord {
  return {
    id,
    timestamp,
    kind: 'model_inference',
    decision: 'allow',
    reasonCode: 'egress_allowed',
    securityMode: 'controlled_hybrid',
    destination,
    provider,
    model: 'test-model',
    contentBytes,
    sensitivity: 'public',
    tags: [],
    approved: true,
  };
}

test('external egress summary uses parsed hostnames and exact local provider ids', () => {
  const records = [
    allowedModel('host-suffix', 'https://localhost.evil.example/v1', 10),
    allowedModel('query-text', 'https://api.example.test/v1?next=http://localhost', 20),
    allowedModel('localhost', 'http://localhost:11434/v1', 30, 'openai/local'),
    allowedModel('loopback', 'http://127.0.0.1:11434/v1', 40, 'openai'),
    allowedModel('local-provider', '', 50, 'ollama'),
  ];

  const summary = summariseEgressAudit(records, new Date('2026-07-11T12:00:00.000Z'));
  assert.equal(summary.todayContentBytes, 30);
  assert.equal(summary.todayExternalModelCalls, 2);
});
