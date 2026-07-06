// Local Strict security acceptance smoke(scripts).
// Verifies the 2.4 local moat rules without calling any cloud model API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideEgressPolicy, recordEgressDecision } from '../apps/host/src/security/egress-gateway.js';
import { buildOutboundPreview } from '../apps/host/src/security/outbound-preview.js';
import { buildTrustReport } from '../apps/host/src/security/trust-report.js';

type Check = { id: string; ok: boolean; detail: string };

const repoRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const outputRoot = path.join(repoRoot, 'output', 'security');
const workspace = path.join(outputRoot, `local-strict-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const reportPath = path.join(outputRoot, 'local-strict-trust-report.json');
const checks: Check[] = [];

function check(id: string, ok: boolean, detail: string): void {
  checks.push({ id, ok, detail });
  if (!ok) process.exitCode = 1;
}

fs.mkdirSync(workspace, { recursive: true });

const secretText = 'Authorization: Bearer sk-test-local-strict-secret-1234567890';
const cloud = decideEgressPolicy({
  kind: 'model_inference',
  provider: 'kimi-api',
  model: 'kimi-k2.7-code',
  baseUrl: 'https://api.moonshot.ai/v1',
  securityMode: 'local_strict',
  content: secretText,
});
recordEgressDecision(workspace, cloud);
check('cloud-model-denied', cloud.decision === 'deny', cloud.reasonCode);

const local = decideEgressPolicy({
  kind: 'model_inference',
  provider: 'ollama',
  model: 'qwen2.5:0.5b',
  baseUrl: 'http://127.0.0.1:11434/v1',
  securityMode: 'local_strict',
  content: 'local model prompt',
});
recordEgressDecision(workspace, local);
check('ollama-model-allowed', local.decision === 'allow', local.reasonCode);

const webFetch = decideEgressPolicy({
  kind: 'web_fetch',
  destination: 'https://example.com',
  securityMode: 'local_strict',
});
recordEgressDecision(workspace, webFetch);
check('webfetch-denied', webFetch.decision === 'deny', webFetch.reasonCode);

const preview = buildOutboundPreview({
  purpose: 'model_inference',
  destination: 'https://api.moonshot.ai/v1',
  provider: 'kimi-api',
  model: 'kimi-k2.7-code',
  securityMode: 'local_strict',
  content: secretText,
});
check('secret-redacted', !preview.redactedPreview.includes('sk-test-local-strict-secret'), preview.redactedPreview);

const report = buildTrustReport({
  trustedRoot: workspace,
  securityMode: 'local_strict',
  modelConfig: {
    provider: 'ollama',
    model: 'qwen2.5:0.5b',
    baseUrl: 'http://127.0.0.1:11434/v1',
    securityMode: 'local_strict',
  },
  sandboxNetworkIsolated: false,
});
fs.mkdirSync(outputRoot, { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify({ ...report, checks: [...report.checks, ...checks] }, null, 2)}\n`, 'utf8');
check('trust-report-written', fs.existsSync(reportPath), reportPath);
check('audit-records-present', report.egress.recordCount >= 3, String(report.egress.recordCount));
check('actual-external-egress-zero', report.egress.todayContentBytes === 0, `${report.egress.todayContentBytes} bytes`);
check('external-model-calls-zero', report.egress.todayExternalModelCalls === 0, `${report.egress.todayExternalModelCalls} calls`);

console.log(JSON.stringify({
  ok: checks.every((item) => item.ok),
  reportPath,
  workspace,
  checks,
  egress: report.egress,
}, null, 2));
