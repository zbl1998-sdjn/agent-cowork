# Agent Cowork Product Security Charter

## Scope

This charter defines the product boundary for Agent Cowork as a local-first desktop agent with optional enterprise and SaaS integration. The default engineering rule is fail closed: do not send prompts, files, tool outputs, credentials, or workspace paths to remote services unless the selected security mode allows it and the user can see that boundary.

## Security Modes

| Mode | Intended use | Model routing | Tool boundary |
| --- | --- | --- | --- |
| `local_strict` | Offline/local-first work, confidential source or customer data | Local model providers only | External network tools are blocked. High-risk execution tools require a network-isolated Docker/VM sandbox. |
| `enterprise_hybrid` | Customer-managed gateway or private deployment | Local models and customer gateways only | External network tools require approval; customer connectors must be declared. |
| `saas_opt_in` | Explicit online/SaaS usage | External providers are allowed and must be visible in audit/UX | Existing approvals and policy decisions still apply. |

Configuration source of truth:

- `SECURITY_MODE` or `KCW_SECURITY_MODE`
- Optional customer gateway host allowlist: `KCW_CUSTOMER_MODEL_GATEWAY_HOSTS`

## Hard Rules

- Host remains the policy enforcement point for model calls, tool calls, sandbox execution, credentials, and telemetry.
- UI and Tauri shell do not make direct model/tool/security decisions.
- Local subprocess execution must never be described as network-isolated.
- If Local Strict cannot provision Docker/VM isolation, high-risk execution tools are blocked instead of silently falling back to local subprocess.
- External providers are classified before runtime calls. A denied provider is filtered out before any HTTP request.
- Telemetry upload surfaces must use allowlisted summaries only.

## Current Code Evidence

- Security mode and provider policy: `apps/host/src/security/security-mode.ts`
- Tool policy decision: `apps/host/src/security/policy-decision.ts`
- Telemetry allowlist: `apps/host/src/security/telemetry-allowlist.ts`
- Tamper-evident audit chain: `apps/host/src/storage/audit-chain.ts`
- Model candidate filtering: `apps/host/src/kimi/agent/model-resilience.ts`
- Tool enforcement: `apps/host/src/kimi/agent/tool-call-executor.ts` and `apps/host/src/routes/tool-routes.ts`
- Sandbox startup posture: `apps/host/src/sandbox/startup-probe.ts`

## Out Of Scope For This Slice

- Real cloud control plane deployment.
- Billing, SSO, SCIM, or tenant admin UI.
- Real customer gateway deployment.
- Marketplace connector publication.
