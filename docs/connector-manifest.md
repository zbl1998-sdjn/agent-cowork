# Connector Manifest

Connectors must declare their data boundary before they can be installed or exposed as tools.

## Format

```json
{
  "id": "github",
  "version": "0.1.0",
  "displayName": "GitHub",
  "auth": {
    "type": "oauth_device",
    "requiredEnv": ["KCW_GITHUB_OAUTH_CLIENT_ID"]
  },
  "network": {
    "external": true,
    "hosts": ["github.com", "api.github.com"]
  },
  "scopes": [
    {
      "id": "repo:read",
      "risk": "low",
      "description": "Read repository metadata and issues"
    },
    {
      "id": "repo:write",
      "risk": "high",
      "description": "Create or modify repository content"
    }
  ],
  "tools": [
    {
      "name": "mcp__github__search_issues",
      "risk": "low",
      "mutating": false,
      "requiresApproval": false
    },
    {
      "name": "mcp__github__create_issue",
      "risk": "high",
      "mutating": true,
      "requiresApproval": true
    }
  ],
  "telemetry": {
    "allowedFields": ["calls", "status", "durationMs", "reasonCode"]
  }
}
```

## Validation Rules

- `id`, `version`, `network`, `scopes`, and `tools` are required.
- External connectors are not available in `local_strict` unless they are explicitly modeled as local-only connectors.
- Mutating or high-risk tools must set `requiresApproval=true`.
- OAuth credentials stay in the Host credential store; manifests must not contain client secrets or access tokens.
- Telemetry fields must be a subset of the Host allowlist.

## Current Boundary

The current code has OAuth approvals and MCP tool registration, but this manifest is a productization contract for the next connector hardening slice. Until then, unknown MCP tools remain high-risk and approval-gated by default.
