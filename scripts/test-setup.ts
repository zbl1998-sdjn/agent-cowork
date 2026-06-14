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

//  - 清空模型/记忆相关 env:HOST 套件断言的是 createServer 的「默认」配置
//    (如 baseUrl=DEFAULT_BASE_URL=api.moonshot.ai/v1)。开发/演示 shell 里若设了
//    KIMI_BASE_URL=...moonshot.cn 之类、或用 `--env-file=.env`/`demo:mvp` 继承进来,
//    会渗入默认值导致 server.test.ts 等误挂。门禁必须与开发者 shell 解耦。
//    需要这些值的用例都显式传 config/env,不依赖 process.env。
for (const key of [
  'KIMI_API_KEY', 'KIMI_BASE_URL', 'KIMI_MODEL', 'KIMI_MODEL_FALLBACKS',
  'MOONSHOT_API_KEY', 'MOONSHOT_BASE_URL',
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'CLAUDE_API_KEY', 'CLAUDE_MODEL',
  'KCW_MODEL_FALLBACKS',
  'MASE_MCP_ENABLED', 'MASE_REPO', 'MASE_CONFIG_PATH', 'MASE_MEMORY_DIR',
]) {
  Reflect.deleteProperty(process.env, key);
}
