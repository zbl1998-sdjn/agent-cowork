ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS workspace_key TEXT NOT NULL DEFAULT 'legacy';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'conversations'::regclass
      AND conname = 'conversations_pkey'
      AND pg_get_constraintdef(oid) LIKE '%workspace_key%'
  ) THEN
    ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_pkey;
    ALTER TABLE conversations ADD CONSTRAINT conversations_pkey PRIMARY KEY (tenant_id, user_id, workspace_key, id);
  END IF;
END $$;

DROP INDEX IF EXISTS conversations_tenant_user_updated;
CREATE INDEX IF NOT EXISTS conversations_tenant_user_workspace_updated
  ON conversations (tenant_id, user_id, workspace_key, updated_at DESC);
