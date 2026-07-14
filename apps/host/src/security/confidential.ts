// 机密模式总开关(host · L0 基础层 · security)
// ---------------------------------------------------------------------------
// 职责:企业「隔离档」的一键 profile——KCW_CONFIDENTIAL 开启后,resolveSecurityMode
//       强制返回 air_gap(任何配置/env 不能削弱),全部 L0 策略消费方(模型 provider
//       策略、工具策略、出口网关)自动继承 fail-closed;并提供启动期 MCP 服务器过滤
//       (机密档不连接任何外部进程记忆后端,含 MASE 桥接)。
// 依赖:无(纯函数,保持 L0)。导出:isConfidentialMode / filterMcpServersForConfidential /
//       stripProxyEnv / applyConfidentialProxyLockdown。
// 设计:开关只认显式真值(1/true/on/yes),其余一律按关闭处理——宁可少开不误开;
//       语义是"收紧",永远不会因解析歧义而放宽任何边界。

export type ConfidentialEnv = Record<string, string | undefined>;

// 转发代理环境变量(大小写变体都列全)。真机验收(2026-07-07)发现:Windows 防火墙不过滤
// loopback,本机转发代理(http(s)_proxy=127.0.0.1:xxxx)是 netsh 封不住的出网旁路;host 自身
// fetch(undici)默认不读这些变量,但它 spawn 的子进程(shell 工具/curl/git/npm)会继承并使用。
// 故机密模式在进程装配处把它们从 env 剥离,并置 NO_PROXY=* 兜底,切断经代理外泄。
const PROXY_ENV_KEYS = [
  'http_proxy', 'https_proxy', 'all_proxy', 'ftp_proxy',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'FTP_PROXY',
] as const;

export type ProxyLockdownResult = { applied: boolean; stripped: string[] };

/**
 * 从给定 env 剥离转发代理变量并置 NO_PROXY=*(兜底:即便变量残留也全量绕过代理)。
 * 纯粹按 env 对象操作(会就地删除/设置键),返回被剥离的键名。不判机密模式——由调用方门控。
 */
export function stripProxyEnv(env: ConfidentialEnv = process.env): string[] {
  const stripped: string[] = [];
  for (const key of PROXY_ENV_KEYS) {
    if (env[key] !== undefined && env[key] !== '') {
      // Reflect.deleteProperty:对 process.env 是真删除(直接赋 undefined 会被 Node 强转成字符串 "undefined")。
      Reflect.deleteProperty(env, key);
      stripped.push(key);
    }
  }
  // 置空绕过表:NO_PROXY=* 让所有仍读代理的工具对任意主机都直连,不经代理。
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  return stripped;
}

/**
 * 机密模式代理封锁:仅当机密模式开启时,对 process.env(默认)剥离代理变量 + 置 NO_PROXY=*。
 * 幂等,可在启动装配处安全重复调用。非机密模式不动 env。
 */
export function applyConfidentialProxyLockdown(env: ConfidentialEnv = process.env): ProxyLockdownResult {
  if (!isConfidentialMode(env)) return { applied: false, stripped: [] };
  return { applied: true, stripped: stripProxyEnv(env) };
}

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/** 机密模式是否开启:仅显式真值(1/true/on/yes)生效,其余(含未设置)一律 false。 */
export function isConfidentialMode(env: ConfidentialEnv = process.env): boolean {
  return TRUTHY.has(String((env.ACW_CONFIDENTIAL ?? env.KCW_CONFIDENTIAL) ?? '').trim().toLowerCase());
}

export type McpServerFilterResult<T> = {
  servers: T[];
  dropped: T[];
  reason: string;
};

/**
 * 启动期 MCP 服务器过滤:机密模式下丢弃全部启动连接器(含 MASE 记忆桥接)——
 * 机密档承诺"不连接任何外部进程记忆后端",不做逐项白名单以免误放。
 * 非机密模式原样透传。
 */
export function filterMcpServersForConfidential<T>(
  servers: T[],
  env: ConfidentialEnv = process.env,
): McpServerFilterResult<T> {
  if (!isConfidentialMode(env)) {
    return { servers, dropped: [], reason: '' };
  }
  return {
    servers: [],
    dropped: servers,
    reason: '机密模式:启动期 MCP 连接器已全部禁用(含 MASE 记忆桥接)——机密档不连接任何外部进程记忆后端。',
  };
}
