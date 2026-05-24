ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS branches JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS active_branch_id TEXT;
