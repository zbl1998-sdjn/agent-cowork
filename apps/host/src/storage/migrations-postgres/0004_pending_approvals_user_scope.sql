-- Bind pending approvals to one authenticated tenant/user pair.
-- This migration is intentionally forward-only: reverting the application
-- requires restoring a pre-migration database snapshot rather than dropping
-- identity data from a live approvals table.

BEGIN;

ALTER TABLE pending_approvals
  ADD COLUMN IF NOT EXISTS user_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_attribute attribute
    WHERE attribute.attrelid = 'pending_approvals'::regclass
      AND attribute.attname = 'user_id'
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
      AND attribute.atttypid = 'pg_catalog.text'::regtype
      AND attribute.atttypmod = -1
      AND NOT attribute.attnotnull
      AND NOT attribute.atthasdef
      AND attribute.attidentity = ''
      AND attribute.attgenerated = ''
  ) THEN
    RAISE EXCEPTION 'PostgreSQL approval migration drift: user_id column';
  END IF;
END $$;

-- Legacy pending rows have no trustworthy user owner. Expire them instead of
-- allowing any user in the tenant to inherit or resolve them.
UPDATE pending_approvals
SET status = 'expired',
    decision = 'migration_user_scope_required',
    resolved_at = NOW()
WHERE status = 'pending'
  AND (
    char_length(tenant_id) BETWEEN 1 AND 96
    AND (tenant_id COLLATE "C") !~ '[^A-Za-z0-9_.:-]'
    AND char_length(user_id) BETWEEN 1 AND 96
    AND (user_id COLLATE "C") !~ '[^A-Za-z0-9_.:-]'
  ) IS NOT TRUE;

CREATE TEMP TABLE pending_approvals_scope_contract_0004
  (LIKE pending_approvals)
  ON COMMIT DROP;

ALTER TABLE pg_temp.pending_approvals_scope_contract_0004
  ADD CONSTRAINT pending_approvals_scope_check_expected_0004
  CHECK (
    status <> 'pending'
    OR (
      char_length(tenant_id) BETWEEN 1 AND 96
      AND (tenant_id COLLATE "C") !~ '[^A-Za-z0-9_.:-]'
      AND char_length(user_id) BETWEEN 1 AND 96
      AND (user_id COLLATE "C") !~ '[^A-Za-z0-9_.:-]'
    ) IS TRUE
  ) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'pending_approvals'::regclass
      AND conname = 'pending_approvals_pending_scope_check'
  ) THEN
    ALTER TABLE pending_approvals
      ADD CONSTRAINT pending_approvals_pending_scope_check
      CHECK (
        status <> 'pending'
        OR (
          char_length(tenant_id) BETWEEN 1 AND 96
          AND (tenant_id COLLATE "C") !~ '[^A-Za-z0-9_.:-]'
          AND char_length(user_id) BETWEEN 1 AND 96
          AND (user_id COLLATE "C") !~ '[^A-Za-z0-9_.:-]'
        ) IS TRUE
      ) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_constraint actual
    JOIN pg_catalog.pg_constraint expected
      ON expected.conrelid = 'pg_temp.pending_approvals_scope_contract_0004'::regclass
     AND expected.conname = 'pending_approvals_scope_check_expected_0004'
    WHERE actual.conrelid = 'pending_approvals'::regclass
      AND actual.conname = 'pending_approvals_pending_scope_check'
      AND actual.contype = expected.contype
      AND actual.conkey = expected.conkey
      AND actual.condeferrable = expected.condeferrable
      AND actual.condeferred = expected.condeferred
      AND actual.connoinherit = expected.connoinherit
      AND actual.conislocal = expected.conislocal
      AND actual.coninhcount = expected.coninhcount
      AND COALESCE((to_jsonb(actual)->>'conenforced')::boolean, TRUE)
        = COALESCE((to_jsonb(expected)->>'conenforced')::boolean, TRUE)
      AND regexp_replace(actual.conbin::text, ':location -?[0-9]+', ':location', 'g')
        = regexp_replace(expected.conbin::text, ':location -?[0-9]+', ':location', 'g')
  ) THEN
    RAISE EXCEPTION 'PostgreSQL approval migration drift: pending scope CHECK';
  END IF;
END $$;

ALTER TABLE pending_approvals
  VALIDATE CONSTRAINT pending_approvals_pending_scope_check;

CREATE INDEX pending_approvals_scope_contract_0004_idx
  ON pg_temp.pending_approvals_scope_contract_0004 (tenant_id, user_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS pending_approvals_tenant_user_pending
  ON pending_approvals (tenant_id, user_id)
  WHERE status = 'pending';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_index actual
    JOIN pg_catalog.pg_class actual_index ON actual_index.oid = actual.indexrelid
    JOIN pg_catalog.pg_class actual_table ON actual_table.oid = actual.indrelid
    JOIN pg_catalog.pg_index expected
      ON expected.indrelid = 'pg_temp.pending_approvals_scope_contract_0004'::regclass
    JOIN pg_catalog.pg_class expected_index
      ON expected_index.oid = expected.indexrelid
     AND expected_index.relname = 'pending_approvals_scope_contract_0004_idx'
    WHERE actual.indrelid = 'pending_approvals'::regclass
      AND actual_index.relname = 'pending_approvals_tenant_user_pending'
      AND actual_index.relnamespace = actual_table.relnamespace
      AND actual_index.relam = expected_index.relam
      AND actual.indisunique = expected.indisunique
      AND actual.indisprimary = expected.indisprimary
      AND actual.indisexclusion = expected.indisexclusion
      AND actual.indimmediate = expected.indimmediate
      AND actual.indisvalid = expected.indisvalid
      AND actual.indisready = expected.indisready
      AND actual.indislive = expected.indislive
      AND actual.indnatts = expected.indnatts
      AND actual.indnkeyatts = expected.indnkeyatts
      AND actual.indkey = expected.indkey
      AND actual.indclass = expected.indclass
      AND actual.indcollation = expected.indcollation
      AND actual.indoption = expected.indoption
      AND regexp_replace(COALESCE(actual.indexprs::text, ''), ':location -?[0-9]+', ':location', 'g')
        = regexp_replace(COALESCE(expected.indexprs::text, ''), ':location -?[0-9]+', ':location', 'g')
      AND regexp_replace(COALESCE(actual.indpred::text, ''), ':location -?[0-9]+', ':location', 'g')
        = regexp_replace(COALESCE(expected.indpred::text, ''), ':location -?[0-9]+', ':location', 'g')
  ) THEN
    RAISE EXCEPTION 'PostgreSQL approval migration drift: pending scope index';
  END IF;
END $$;

COMMIT;
