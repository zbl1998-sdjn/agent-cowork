// 路径安全策略静态黑名单(host · L0 基础层 · security)
// ---------------------------------------------------------------------------
// 职责:集中存放路径访问策略所需的纯数据黑名单——敏感目录名/文件名/扩展名,以及
//       工作区检索忽略目录;只放常量、不引入任何运行依赖,供 path-policy 等模块消费。
// 导出:SENSITIVE_SEGMENTS, SENSITIVE_FILENAMES, SENSITIVE_EXTENSIONS, WORKSPACE_IGNORED_SEGMENTS。

// 敏感「目录名」黑名单:路径中任意一段命中即视为敏感(凭据库、密钥目录等)。
export const SENSITIVE_SEGMENTS = new Set([
  '.aws',
  '.azure',
  '.docker',
  '.git',
  '.gnupg',
  '.kube',
  '.ssh',
  '.env',
  'appdata',
  'credentials',
  '.kimi',
]);

// 敏感「文件名」黑名单:即便落在可信根内,这些文件也不允许被工具读写。
export const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
]);

// 敏感「扩展名」黑名单:证书/私钥文件。
export const SENSITIVE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx']);

// 工作区检索时应忽略的目录(体积大且无业务价值),用于「可读工作区」收窄。
export const WORKSPACE_IGNORED_SEGMENTS = new Set(['node_modules', 'dist', 'build', 'coverage']);
