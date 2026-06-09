// SSRF 防护(host · L1 领域层,服务于 web.fetch)
// ---------------------------------------------------------------------------
// 职责:把「字符串前缀匹配」这种可被三类手法绕过(DNS 解析到内网 / 数字型 IPv4 /
//       被遗漏的私网段)的朴素做法,升级为「真解析到 IP + 归一化数字形式 + 命中任一
//       私网/保留/回环段即拒绝」。由 web.fetch 在每跳重定向上复用。
// 依赖:node:dns / node:net。导出:numericHostToV4 / isBlockedIp / assertPublicHost。
import dns from 'node:dns';
import net from 'node:net';

type BlockedError = Error & { statusCode: number };
type LookupOptions = {
  lookupImpl?: (host: string) => Promise<unknown> | unknown;
};

// 总是指向本机的主机名,无需 DNS 往返即可阻断。
const BLOCKED_NAME_RE = /(^|\.)localhost$/i;

function blocked(message: string, why?: string): BlockedError {
  const error = new Error(`host "${message}" is blocked (internal/loopback)${why ? `: ${why}` : ''}`) as BlockedError;
  error.statusCode = 400;
  return error;
}

type V4Octets = [number, number, number, number];

function parseDottedV4(ip: string): V4Octets | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number) as V4Octets;
  return octets.some((n) => n > 255) ? null : octets;
}

function isBlockedV4(octets: V4Octets): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 表示本机/本网络。
  if (a === 10) return true; // 10/8 私网。
  if (a === 127) return true; // 127/8 回环。
  if (a === 169 && b === 254) return true; // 169.254/16 链路本地,含云元数据地址。
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网。
  if (a === 192 && b === 168) return true; // 192.168/16 私网。
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 运营商 NAT。
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF 保留。
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 基准测试网段。
  if (a >= 224) return true; // 组播、保留及广播段。
  return false;
}

/**
 * 把「数字型 IPv4」主机名(点分/十进制/十六进制/八进制)归一化为四段八位组;非数字 IPv4 返回 null。
 */
export function numericHostToV4(host: string): V4Octets | null {
  const dotted = parseDottedV4(host);
  if (dotted) return dotted;
  if (!/^(0x[0-9a-f]+|\d+)$/i.test(host)) return null;
  let value = 0;
  if (/^0x/i.test(host)) value = parseInt(host, 16);
  else if (/^0[0-7]+$/.test(host)) value = parseInt(host, 8);
  else value = parseInt(host, 10);
  if (!Number.isFinite(value) || value < 0 || value > 0xffffffff) return null;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

/** 字面 IP(IPv4/IPv6,含 ::ffff 映射)是否落在私网/保留/回环段。 */
export function isBlockedIp(ip: string): boolean {
  const dotted = parseDottedV4(ip);
  if (dotted) return isBlockedV4(dotted);
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::1' || lower === '::') return true;
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
    if (mapped) {
      const mappedAddress = mapped[1];
      if (!mappedAddress) return true;
      const octets = parseDottedV4(mappedAddress);
      return octets ? isBlockedV4(octets) : true;
    }
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 唯一本地地址。
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 链路本地。
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // ff00::/8 组播。
    return false;
  }
  return false;
}

/**
 * 断言主机名可安全抓取:数字/字面 IP 直接判定,域名则解析后要求「全部」地址均为公网;否则抛错(消息含 "blocked")。
 */
export async function assertPublicHost(hostname: string, { lookupImpl }: LookupOptions = {}): Promise<void> {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) throw blocked(host, 'empty host');
  if (BLOCKED_NAME_RE.test(host)) throw blocked(host);

  const numeric = numericHostToV4(host);
  if (numeric) {
    if (isBlockedV4(numeric)) throw blocked(host);
    return;
  }
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw blocked(host);
    return;
  }

  const lookup = lookupImpl || ((name) => dns.promises.lookup(name, { all: true, verbatim: true }));
  let records;
  try {
    records = await lookup(host);
  } catch {
    throw blocked(host, 'dns resolution failed');
  }
  const list = Array.isArray(records) ? records : [records];
  if (!list.length) throw blocked(host, 'no addresses');
  for (const record of list) {
    const address =
      typeof record === 'string'
        ? record
        : record && typeof record === 'object' && 'address' in record
          ? String(record.address || '')
          : '';
    if (!address || isBlockedIp(String(address))) {
      throw blocked(host, `resolves to blocked address ${address}`);
    }
  }
}
