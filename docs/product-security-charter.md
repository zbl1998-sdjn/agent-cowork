# Agent Cowork Product Security Charter

## Scope

This charter defines the product boundary for Agent Cowork as a local-first desktop agent with optional enterprise integration and a reserved SaaS posture. The default engineering rule is fail closed: do not send prompts, files, tool outputs, credentials, or workspace paths to remote services unless the selected security mode allows it, a consumable approval receipt exists where required, and the user can see that boundary.

## Security Modes

| Mode | Intended use | Model routing | Tool boundary |
| --- | --- | --- | --- |
| `local_strict` | Offline/local-first work, confidential source or customer data | Local model providers only | External network tools are blocked. High-risk execution tools require a network-isolated Docker/VM sandbox. |
| `enterprise_hybrid` | Customer-managed gateway or private deployment | Local models and customer gateways only | External network tools require approval; customer connectors must be declared. |
| `saas_opt_in` | Reserved explicit online/SaaS posture | Public providers remain blocked in the current Internal Beta because the scoped approval-receipt consumer is not accepted | Existing approvals and policy decisions still apply; selecting the mode alone grants no egress. |

Configuration source of truth:

- `SECURITY_MODE` or `KCW_SECURITY_MODE`
- Optional customer gateway host allowlist: `KCW_CUSTOMER_MODEL_GATEWAY_HOSTS`
- Host-global mutation administrator allowlist: `KCW_GLOBAL_MUTATION_ADMINS` as a JSON array of exact `{tenantId,userId}` tuples. Unset defaults to `tenant_local/user_local`; an explicit value replaces that default and malformed values stop startup.

## Hard Rules

- Host remains the policy enforcement point for model calls, tool calls, sandbox execution, credentials, and telemetry.
- UI and Tauri shell do not make direct model/tool/security decisions.
- Local subprocess execution must never be described as network-isolated.
- If Local Strict cannot provision Docker/VM isolation, high-risk execution tools are blocked instead of silently falling back to local subprocess.
- External providers are classified before runtime calls. A denied provider is filtered out before any HTTP request.
- Telemetry upload surfaces must use allowlisted summaries only.
- Kimi host config, MCP registry connect/disconnect, skill enabled state, data purge, and retention are host-global mutations. They require an exact server-derived tenant/user allowlist match before request-body parsing or any side effect; client role/header/query/body claims grant no authority.

## Current Code Evidence

- Security mode and provider policy: `apps/host/src/security/security-mode.ts`
- Tool policy decision: `apps/host/src/security/policy-decision.ts`
- Telemetry allowlist: `apps/host/src/security/telemetry-allowlist.ts`
- Tamper-evident audit chain: `apps/host/src/storage/audit-chain.ts`
- Model candidate filtering: `apps/host/src/kimi/agent/model-resilience.ts`
- Model endpoint validation and receipt boundary: `apps/host/src/security/model-gateway-policy.ts`, `apps/host/src/security/model-endpoint-request.ts`, and `apps/host/src/security/model-egress-approval.ts`
- Host-global mutation authorization: `apps/host/src/auth/global-mutation-admin.ts`
- Tool enforcement: `apps/host/src/kimi/agent/tool-call-executor.ts` and `apps/host/src/routes/tool-routes.ts`
- Sandbox startup posture: `apps/host/src/sandbox/startup-probe.ts`

## Out Of Scope For This Slice

- Real cloud control plane deployment.
- Billing, SSO, SCIM, or tenant admin UI.
- Real customer gateway deployment.
- Marketplace connector publication.
