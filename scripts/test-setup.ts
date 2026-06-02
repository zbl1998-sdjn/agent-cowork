// HOST 测试套件的环境预置(scripts · 工具库)
// ---------------------------------------------------------------------------
// 职责:在 HOST 单测进程启动前注入测试用环境变量,放开鉴权门禁、信任身份头、
//   关闭鉴权持久化,使无 token 的功能测试不被 401、且多租户/鉴权用例仍能各自覆盖真实语义。
// 用法:由 test:host 的 `--import ../../scripts/test-setup.ts` 预加载(见 package.json),
//   不单独触发;仅设置 process.env,无导出、无副作用执行逻辑。
// Preloaded via `node --test --import ../../scripts/test-setup.ts` for the HOST suite.
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
