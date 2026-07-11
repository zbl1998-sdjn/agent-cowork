// 已发布 PostgreSQL 迁移的不可变 SHA-256 基线。
// 修改既有 SQL 时 planner 必须失败；任何新结构只能追加新的顺序迁移。
export const PUBLISHED_POSTGRES_MIGRATION_SHA256: Readonly<Record<string, string>> = Object.freeze({
  '0001_init.sql': 'f1635a24df095a371dd8896999322d503c78a21d63c143e2f2e4c41ecddb8c0e',
  '0002_conversation_branches.sql': '3704aaa4b25971a3bc0c36a78535f64dffd9e6c136ab0c9351a794a858d85d86',
  '0003_conversation_workspace_key.sql': 'b70204c92d3b7722fc852ec0c039a2be76099da31c6b6f6125a3254d68f39b1a', // gitleaks:allow -- public migration digest
  '0004_pending_approvals_user_scope.sql': 'e6d602aa24f1b352b049bc70f555dda0185224cc92c6cfa3b78b1a253be47510',
});
