// 路径安全策略的静态黑名单(host · L0 基础层):只放纯数据,不引入运行依赖。

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
