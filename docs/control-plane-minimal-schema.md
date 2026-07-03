# SaaS Control Plane Minimal Schema

This is the minimum schema for future SaaS or enterprise control plane work. It is not a live deployment contract yet.

## Tenants

```sql
create table tenants (
  id text primary key,
  name text not null,
  security_mode text not null check (security_mode in ('local_strict', 'enterprise_hybrid', 'saas_opt_in')),
  created_at timestamptz not null default now()
);
```

## Users

```sql
create table users (
  id text primary key,
  tenant_id text not null references tenants(id),
  email text not null,
  role text not null check (role in ('owner', 'admin', 'member', 'auditor')),
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);
```

## Policy Events

```sql
create table policy_events (
  id text primary key,
  tenant_id text not null references tenants(id),
  user_id text references users(id),
  trace_id text,
  security_mode text not null,
  decision text not null check (decision in ('allow', 'deny', 'needs_approval')),
  subject_type text not null,
  subject_name text not null,
  reason_code text not null,
  created_at timestamptz not null default now()
);
```

## Connector Installations

```sql
create table connector_installations (
  id text primary key,
  tenant_id text not null references tenants(id),
  connector_id text not null,
  manifest_version text not null,
  approved_scopes jsonb not null default '[]'::jsonb,
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  unique (tenant_id, connector_id)
);
```

## Telemetry Summaries

```sql
create table telemetry_summaries (
  id text primary key,
  tenant_id text not null references tenants(id),
  source text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
```

`payload` must be produced by the telemetry allowlist sanitizer. Raw prompts, file paths, workspace outputs, URLs, args, and credentials are not valid telemetry fields.
