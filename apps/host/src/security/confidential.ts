// 机密模式总开关(host · L0 基础层 · security)
// ---------------------------------------------------------------------------
// 职责:企业「隔离档」的一键 profile——KCW_CONFIDENTIAL 开启后,resolveSecurityMode
//       强制返回 air_gap(任何配置/env 不能削弱),全部 L0 策略消费方(模型 provider
//       策略、工具策略、出口网关)自动继承 fail-closed;并提供启动期 MCP 服务器过滤
//       (机密档不连接任何外部进程记忆后端,含 MASE 桥接)。
// 依赖:无(纯函数,保持 L0)。导出:isConfidentialMode / filterMcpServersForConfidential。
// 设计:开关只认显式真值(1/true/on/yes),其余一律按关闭处理——宁可少开不误开;
//       语义是"收紧",永远不会因解析歧义而放宽任何边界。

export type ConfidentialEnv = Record<string, string | undefined>;

const TRUTHY = new Set(['1', 'true', 'on', 'yes']);

/** 机密模式是否开启:仅显式真值(1/true/on/yes)生效,其余(含未设置)一律 false。 */
export function isConfidentialMode(env: ConfidentialEnv = process.env): boolean {
  return TRUTHY.has(String(env.KCW_CONFIDENTIAL ?? '').trim().toLowerCase());
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
