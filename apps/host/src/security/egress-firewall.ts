// OS 级出网强制:Windows 防火墙规则计划(host · L1 security · egress-firewall)
// ---------------------------------------------------------------------------
// 职责:为企业隔离档生成"对 app 进程树默认拒绝出站、仅放行 loopback 与内网网关"的
//       Windows 防火墙规则计划(纯函数,不执行);计划发射见 scripts/security-egress-firewall.ts
//       (npm run security:egress-firewall-plan),打印的命令由管理员在提升权限 PowerShell 执行。
//       这是 OS 级强制,补应用层出口网关(Shell/子进程/连接器可绕过应用闸)
//       的纵深防御。
// 依赖:无(纯函数)。导出:buildEgressFirewallPlan / EGRESS_FIREWALL_GROUP。
//
// Windows 防火墙语义提醒(诚实):默认出站策略是 Allow;这里按「per-program 显式 Block +
// loopback/网关 Allow」建规。Windows 防火墙中 Block 规则优先级高于 Allow——因此严格的
// "默认拒绝、仅放行白名单"在纯 netsh 规则下无法完美表达(需要 WFP 带权重的过滤器或
// 机器级出站默认拒绝配置)。本计划提供 program-scoped 阻断 + 白名单放行作为 best-effort
// OS 强制,应用层出口网关仍是主执行点。这一限制在 plan/08 与生成的计划 warnings 中说明。

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/\d{1,2})?$/;
const IPV6_RE = /^[0-9a-f:]+(\/\d{1,3})?$/i;

export const EGRESS_FIREWALL_GROUP = 'Agent Cowork Egress Lockdown';

export type FirewallRule = {
  name: string;
  direction: 'outbound';
  action: 'block' | 'allow';
  program?: string;
  remoteAddress?: string;
  remotePort?: string;
  description: string;
};

export type EgressFirewallPlan = {
  ruleGroup: string;
  rules: FirewallRule[];
  commands: string[];
  removeCommand: string;
  warnings: string[];
  executed: false;
};

function looksLikeIp(host: string): boolean {
  return IPV4_RE.test(host) || (host.includes(':') && IPV6_RE.test(host));
}

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function ruleToCommand(rule: FirewallRule): string {
  const parts = [
    'New-NetFirewallRule',
    `-DisplayName ${psQuote(rule.name)}`,
    `-Group ${psQuote(EGRESS_FIREWALL_GROUP)}`,
    '-Direction Outbound',
    `-Action ${rule.action === 'block' ? 'Block' : 'Allow'}`,
    '-Profile Any',
    '-Enabled True',
  ];
  if (rule.program) parts.push(`-Program ${psQuote(rule.program)}`);
  if (rule.remoteAddress) parts.push(`-RemoteAddress ${psQuote(rule.remoteAddress)}`);
  // -RemotePort 在 Windows 防火墙必须同时指定 -Protocol(TCP/UDP),否则报 "The port is invalid"。
  if (rule.remotePort) parts.push(`-Protocol TCP -RemotePort ${psQuote(rule.remotePort)}`);
  return parts.join(' ');
}

/** 生成隔离档防火墙规则计划(纯函数,不执行)。 */
export function buildEgressFirewallPlan({
  appExePaths,
  allowHosts = [],
  loopbackAllowPorts = [],
}: {
  appExePaths: string[];
  allowHosts?: string[];
  /** 收窄 loopback 放行到这些端口(如本地模型 11434);留空则放行整个 loopback 并告警代理绕过风险。 */
  loopbackAllowPorts?: Array<number | string>;
}): EgressFirewallPlan {
  const exes = appExePaths.map((p) => String(p || '').trim()).filter(Boolean);
  if (exes.length === 0) {
    throw new Error('egress-firewall: at least one app exe path is required to lock down');
  }
  const warnings: string[] = [];
  const rules: FirewallRule[] = [];

  // 放行:loopback(本地 host sidecar 与本地模型端点)。
  // 真机验收(2026-07-07)根因发现:Windows 防火墙【根本不过滤 loopback 流量】——无论有没有
  // "放行 loopback"规则,进程到 127.0.0.1 的连接都不被 netsh 规则拦截。因此若隔离机装了转发
  // 代理(http(s)_proxy 指向 127.0.0.1:7897,如 Mihomo/Clash),被锁进程走系统代理即由代理
  // 进程代为外呼 —— 这是 netsh 规则无法封堵的旁路(不是本放行规则的锅)。收窄端口对此【无效】,
  // 端口收窄仅用于减小本地攻击面;堵代理旁路的唯一手段见下方 warning。
  const ports = loopbackAllowPorts.map((p) => String(p).trim()).filter(Boolean);
  if (ports.length > 0) {
    rules.push({
      name: `${EGRESS_FIREWALL_GROUP} - Allow Loopback Ports ${ports.join(',')}`,
      direction: 'outbound',
      action: 'allow',
      remoteAddress: '127.0.0.0/8',
      remotePort: ports.join(','),
      description: `仅放行回环指定端口出站(本地模型端点 ${ports.join(',')}),不放行本机代理端口`,
    });
  } else {
    rules.push({
      name: `${EGRESS_FIREWALL_GROUP} - Allow Loopback`,
      direction: 'outbound',
      action: 'allow',
      remoteAddress: '127.0.0.0/8',
      description: '允许回环出站(本地 host sidecar / 本地模型端点)',
    });
    warnings.push('未指定 loopbackAllowPorts:整段 127.0.0.0/8 放行(仅减小本地面,不影响下条根因)。');
  }
  // 根因告警(真机复现,始终给):Windows 防火墙不过滤 loopback,本机转发代理是 netsh 封不住的出网旁路。
  warnings.push('【关键】Windows 防火墙不过滤 loopback 流量:若隔离机存在本机转发代理(http(s)_proxy=127.0.0.1:xxxx,如 Mihomo/Clash),被锁进程经代理即可绕过本封锁外呼(2026-07-07 真机复现:经代理 http=301 成功,直连被拦 exit=7)。netsh 规则无法封堵此旁路。唯一有效缓解:①机密档进程环境清除 http_proxy/https_proxy/ALL_PROXY/NO_PROXY;②隔离机不安装本机代理;③或用 WFP 底层过滤器拦代理进程本身。');

  // 放行:内网网关白名单(仅接受可静态判定的 IP/CIDR;主机名需 DNS pin,不静默放行)。
  for (const host of allowHosts.map((h) => String(h || '').trim()).filter(Boolean)) {
    if (looksLikeIp(host)) {
      rules.push({
        name: `${EGRESS_FIREWALL_GROUP} - Allow Gateway ${host}`,
        direction: 'outbound',
        action: 'allow',
        remoteAddress: host,
        description: `允许出站到内网模型网关 ${host}`,
      });
    } else {
      warnings.push(`网关主机名 ${host} 无法静态解析为 IP;防火墙按 IP 判定,请在部署时把它 DNS pin 成固定 IP/CIDR 再加入,否则本计划不为它放行(fail-closed)。`);
    }
  }

  // 阻断:每个 app 可执行文件的其余出站(program-scoped block)。
  for (const exe of exes) {
    rules.push({
      name: `${EGRESS_FIREWALL_GROUP} - Block ${exe.split(/[\\/]/).pop() || exe}`,
      direction: 'outbound',
      action: 'block',
      program: exe,
      description: `阻断 ${exe} 的对外出站(仅放行 loopback 与白名单网关)`,
    });
  }

  warnings.push('Windows 防火墙 Block 优先于 Allow:纯 netsh 规则无法完美表达"默认拒绝仅放行白名单"。本计划为 best-effort OS 强制,应用层出口网关仍是主执行点;需要绝对默认拒绝时用 WFP 带权重过滤器或机器级出站默认拒绝策略。');

  const commands = rules.map(ruleToCommand);
  const removeCommand = `Remove-NetFirewallRule -Group ${psQuote(EGRESS_FIREWALL_GROUP)}`;
  return { ruleGroup: EGRESS_FIREWALL_GROUP, rules, commands, removeCommand, warnings, executed: false };
}
