-- PostgreSQL schema for the multi-instance / high-concurrency backend.
-- Mirrors the SQLite adapters' columns with PG-native types. ULID/string PKs;
-- tenant_id partitionable. record/fact/note/schedule JSON kept as JSONB.

CREATE TABLE IF NOT EXISTS runs_index (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'tenant_local',
  user_id       TEXT NOT NULL DEFAULT 'user_local',
  trace_id      TEXT,
  type          TEXT,
  status        TEXT,
  mode          TEXT,
  provider      TEXT,
  recipe_id     TEXT,
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  duration_ms   BIGINT,
  prompt_preview TEXT,
  error         TEXT,
  run_path      TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ,
  record_json   JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_index_tenant_started ON runs_index (tenant_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_index_tenant_user ON runs_index (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS runs_index_status ON runs_index (tenant_id, status);

-- Cross-session memory: facts (append-only) + notes (one per name), tenant-scoped.
CREATE TABLE IF NOT EXISTS memory_facts (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'tenant_local',
  user_id     TEXT NOT NULL DEFAULT 'user_local',
  trace_id    TEXT,
  key         TEXT NOT NULL,
  value       TEXT,
  scope       TEXT,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,
  fact_json   JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_facts_tenant ON memory_facts (tenant_id, created_at);

CREATE TABLE IF NOT EXISTS memory_notes (
  id          TEXT PRIMARY KEY,
  tenant_id   TEXT NOT NULL DEFAULT 'tenant_local',
  user_id     TEXT NOT NULL DEFAULT 'user_local',
  trace_id    TEXT,
  name        TEXT NOT NULL,
  body        TEXT,
  size        INTEGER,
  created_at  TIMESTAMPTZ,
  updated_at  TIMESTAMPTZ,
  note_json   JSONB NOT NULL,
  UNIQUE (tenant_id, name)
);
CREATE INDEX IF NOT EXISTS memory_notes_tenant ON memory_notes (tenant_id, name);

-- Scheduled tasks (cron + one-shot), tenant-scoped.
CREATE TABLE IF NOT EXISTS schedules (
  id            TEXT PRIMARY KEY,
  tenant_id     TEXT NOT NULL DEFAULT 'tenant_local',
  user_id       TEXT NOT NULL DEFAULT 'user_local',
  trace_id      TEXT,
  name          TEXT,
  kind          TEXT,
  status        TEXT,
  cron          TEXT,
  fire_at       TIMESTAMPTZ,
  next_fire_at  TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ,
  last_run_id   TEXT,
  version       INTEGER NOT NULL DEFAULT 1,
  runs          INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ,
  schedule_json JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS schedules_tenant_next ON schedules (tenant_id, next_fire_at);

-- P2: cross-instance pending approvals (resolved via LISTEN/NOTIFY pub-sub).
CREATE TABLE IF NOT EXISTS pending_approvals (
  id          TEXT PRIMARY KEY,
  run_id      TEXT,
  tenant_id   TEXT,
  kind        TEXT,
  status      TEXT NOT NULL DEFAULT 'pending',
  decision    TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS pending_approvals_run ON pending_approvals (run_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS pending_approvals_created ON pending_approvals (created_at) WHERE status='pending';

-- Per-user conversation history (mirror of FileConversationStore), scoped by
-- (tenant_id, user_id). messages kept as JSONB; title/pinned are columns for
-- search + ordering.
CREATE TABLE IF NOT EXISTS conversations (
  tenant_id   TEXT NOT NULL DEFAULT 'tenant_local',
  user_id     TEXT NOT NULL DEFAULT 'user_local',
  id          TEXT NOT NULL,
  title       TEXT NOT NULL DEFAULT '新对话',
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  messages    JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, user_id, id)
);
CREATE INDEX IF NOT EXISTS conversations_tenant_user_updated ON conversations (tenant_id, user_id, updated_at DESC);
