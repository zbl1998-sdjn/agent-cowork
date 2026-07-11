# Disposable PostgreSQL integration acceptance

This suite is intentionally outside `apps/host/test/*.test.ts`. The default
host test command never skips or silently connects to a database.

Safety contract:

- only `KCW_TEST_POSTGRES_URL` is read; `DATABASE_URL` is never used;
- the URL must target loopback (or the fixed GitHub Actions `postgres`
  service) and an explicitly named test database;
- each test creates one randomized `kcw_it_*` schema and drops only that
  schema during cleanup;
- the repository workflow uses a disposable, digest-pinned PostgreSQL image.

Run only against a disposable local test database:

```powershell
$env:KCW_TEST_POSTGRES_URL = 'postgres://test_user:test_password@127.0.0.1:5432/kcw_test'
node scripts/run-host-node.mjs -- --test --test-concurrency=1 --test-timeout=120000 scripts/postgres-integration/postgres-test-url.test.ts scripts/postgres-integration/postgres-migrations.integration.test.ts scripts/postgres-integration/postgres-approvals.integration.test.ts
```

Do not point this command at a persistent or shared database.
