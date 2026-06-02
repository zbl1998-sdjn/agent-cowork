// SSRF 防护(host · L1 领域层,服务于 web.fetch)
// ---------------------------------------------------------------------------
// 职责:把「字符串前缀匹配」这种可被三类手法绕过(DNS 解析到内网 / 数字型 IPv4 /
//       被遗漏的私网段)的朴素做法,升级为「真解析到 IP + 归一化数字形式 + 命中任一
//       私网/保留/回环段即拒绝」。由 web.fetch 在每跳重定向上复用。
// 依赖:node:dns / node:net。导出:numericHostToV4 / isBlockedIp / assertPublicHost。
//
// SSRF guard for the outbound web.fetch tool. The naive approach — string-match
// the URL hostname against a few private prefixes — is bypassable three ways:
//   1. a DNS name that *resolves* to an internal IP (the string isn't private);
//   2. numeric IPv4 forms (decimal 2130706433, hex 0x7f000001, octal 0177...);
//   3. ranges the prefix list forgot (172.16/12, IPv6 ULA/link-local, CGNAT).
// This module resolves the host to actual addresses, normalizes numeric forms,
// and rejects ANY address that lands in a private/reserved/loopback range. It is
// re-run on every redirect hop by the caller so a 302 → internal can't slip past.
import dns from 'node:dns';
import net from 'node:net';

type BlockedError = Error & { statusCode: number };
type LookupOptions = {
  lookupImpl?: (host: string) => Promise<unknown> | unknown;
};

// Hostnames that always denote the local machine; blocked without a DNS round-trip.
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
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10/8 private
  if (a === 127) return true; // 127/8 loopback
  if (a === 169 && b === 254) return true; // 169.254/16 link-local (incl. 169.254.169.254 metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 private
  if (a === 192 && b === 168) return true; // 192.168/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0/24 IETF
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18/15 benchmarking
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255
  return false;
}

/**
 * 把「数字型 IPv4」主机名(点分/十进制/十六进制/八进制)归一化为四段八位组;非数字 IPv4 返回 null。
 * Normalize a hostname that is actually a numeric IPv4 (dotted, decimal, hex, or
 * octal) into octets. Returns null when the host is not a bare numeric IPv4.
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
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // ff00::/8 multicast
    return false;
  }
  return false;
}

/**
 * 断言主机名可安全抓取:数字/字面 IP 直接判定,域名则解析后要求「全部」地址均为公网;否则抛错(消息含 "blocked")。
 * Assert a URL hostname is safe to fetch — it must resolve only to public
 * addresses. Throws an Error whose message contains "blocked" otherwise.
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
