# Agent Cowork Data Flow

## Local Strict

1. User input enters the local UI and is sent to the loopback Host API.
2. Host builds request context with tenant, user, trace, and `securityMode=local_strict`.
3. Model router only allows local providers such as `openai/local`, `local-openai`, `ollama`, or loopback base URLs.
4. External network tools such as `WebFetch`, `web.fetch`, and `web.search` are denied by policy before handlers run.
5. Execution tools such as `Shell`, `sandbox.exec`, and `sandbox.run-code` require a network-isolated Docker/VM sandbox. If only local subprocess is available, policy denies high-risk execution.
6. Telemetry export uses summary counters only. Prompts, files, paths, outputs, raw args, URLs, and credentials are rejected by allowlist sanitizer.

## Enterprise Hybrid

1. Host may use local models or customer-managed model gateway hosts.
2. Customer gateway hosts must be explicitly listed in the administrator-controlled `KCW_CUSTOMER_MODEL_GATEWAY_HOSTS` allowlist. Plain entries are exact hosts and only a leading `*.` enables strict subdomain matching; private/internal names are never trusted merely because of their address or suffix.
3. Every resolved address is checked before connection, the validated address is pinned for the request, and redirects are not followed with model credentials.
4. External model providers are denied before runtime calls unless a scoped, expiring, single-use approval receipt is available. The current Internal Beta has no accepted receipt consumer, so public-cloud execution remains unavailable.
5. External network tools require approval and connector declaration.
6. Persistent state may use file, SQLite, or Postgres depending on deployment config.

## SaaS Opt-In (reserved policy posture)

1. `saas_opt_in` maps to `controlled_hybrid`, but it does not by itself authorize external model execution.
2. Policy audit marks external provider classification; the runtime still requires a scoped approval receipt and therefore fails closed in the current Internal Beta.
3. Existing credential store, auth, rate limiting, idempotency, and approval paths still apply.
4. Telemetry remains allowlisted; SaaS mode does not permit uploading raw prompts or workspace content by default.

## Non-Goals

- Browser/Tauri shell does not bypass Host policy.
- Direct `/api/tools/call` cannot bypass `PolicyDecision`.
- Sandbox startup status is advisory plus enforcement metadata; actual tool execution is still checked by runtime policy.
