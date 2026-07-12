# Enterprise Local Strict Demo

## Goal

Demonstrate that Agent Cowork can run in a confidential local-first posture without silently calling external providers or falling back to unsafe execution.

## Environment

```powershell
$env:SECURITY_MODE = 'local_strict'
$env:KCW_MODEL_PROVIDER = 'openai/local'
$env:KIMI_BASE_URL = 'http://127.0.0.1:11434/v1'
$env:KIMI_MODEL = 'local-demo-model'
$env:KCW_SANDBOX_BACKEND = 'auto'
# Optional Docker backend: pull a fixed manifest digest and pass its local immutable image ID.
# $pinnedRef = 'alpine@sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1'
# docker pull $pinnedRef
# $imageId = docker image inspect --format='{{.Id}}' $pinnedRef
# if ($imageId -notmatch '^sha256:[0-9a-f]{64}$') { throw "non-immutable image ID: $imageId" }
# $env:KCW_SANDBOX_DOCKER_IMAGE = $imageId
```

## Expected Behavior

- `/api/selfcheck` shows `security.mode=local_strict`.
- External model candidates are filtered before runtime calls.
- `WebFetch` and `web.fetch` are blocked with `POLICY_DENIED`.
- `Shell` and `sandbox.exec` require Docker/VM network isolation; local subprocess is not accepted as an isolated fallback.
- Safe workspace search/read tools continue to work.
- Safe cache telemetry contains counters and slots, not raw cache keys or prompts.
- Audit JSONL records contain `prev_hash` and `event_hash`; changing any chained line fails verification.

## Demo Commands

```powershell
npm run check
node scripts/run-host-node.mjs --cwd apps/host -- --test --test-timeout=60000 test/security-mode.test.ts test/policy-decision.test.ts test/cache-telemetry.test.ts test/audit-events.test.ts test/model-resilience.test.ts test/tool-call-executor.test.ts test/sandbox-startup.test.ts test/tools.test.ts
```

## Audit Chain Evidence

Action and memory audit subscribers write a tamper-evident JSONL chain. Each chained record includes:

- `chain_version`
- `hash_algorithm`
- `prev_hash`
- `event_hash`

Use `verifyAuditHashChain` from `apps/host/src/runtime/audit-events.ts` to validate an exported audit package. The current regression test changes one chained record after writing and verifies that the chain fails with `event_hash mismatch`.

## Boundary To State In Demos

This slice proves local policy enforcement and test coverage. It does not prove real enterprise SSO, billing, hosted control plane, or a production customer gateway deployment.
