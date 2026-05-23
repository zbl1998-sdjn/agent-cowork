// Preloaded via `node --test --import ./test-setup.mjs` for the HOST suite.
//  - KCW_REQUIRE_AUTH=false: open the gate so tokenless functional tests aren't
//    401'd (auth-gate.test.js sets requireAuth:true explicitly, so the gate is
//    still verified there).
//  - KCW_TRUST_IDENTITY_HEADERS=true: legacy multi-tenant tests assert isolation
//    by passing x-tenant-id/x-user-id headers. Production never trusts those, but
//    enabling it here lets those tests keep their semantics without a token dance.
//  - KCW_AUTH_PERSIST=false: tests use the in-memory auth store (no auth.sqlite
//    written into temp roots); auth-store-sqlite.test.js exercises persistence
//    explicitly with its own dbPath.
process.env.KCW_REQUIRE_AUTH = 'false';
process.env.KCW_TRUST_IDENTITY_HEADERS = 'true';
process.env.KCW_AUTH_PERSIST = 'false';
