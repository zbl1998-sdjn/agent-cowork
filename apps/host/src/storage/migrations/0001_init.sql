CREATE TABLE IF NOT EXISTS runs_index (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  trace_id TEXT,
  type TEXT,
  status TEXT,
  mode TEXT,
  provider TEXT,
  recipe_id TEXT,
  started_at TEXT,
  finished_at TEXT,
  duration_ms BIGINT,
  prompt_preview TEXT,
  error TEXT,
  run_path TEXT,
  version BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  record_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_index_tenant_created_at
  ON runs_index (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_facts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  trace_id TEXT,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  fact_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memory_facts_tenant_created_at
  ON memory_facts (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS memory_notes (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  trace_id TEXT,
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  size BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  note_json TEXT NOT NULL,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_memory_notes_tenant_created_at
  ON memory_notes (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  user_id TEXT,
  trace_id TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  cron TEXT,
  fire_at TEXT,
  next_fire_at TEXT,
  last_fired_at TEXT,
  last_run_id TEXT,
  version BIGINT NOT NULL,
  runs BIGINT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  schedule_json TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_tenant_created_at
  ON schedules (tenant_id, created_at DESC);
