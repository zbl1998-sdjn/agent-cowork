// @ts-check
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

// Hostnames that always denote the local machine; blocked without a DNS round-trip.
const BLOCKED_NAME_RE = /(^|\.)localhost$/i;

/** @param {string} message @param {string} [why] @returns {Error & { statusCode: number }} */
function blocked(message, why) {
  const error = /** @type {Error & { statusCode: number }} */ (
    new Error(`host "${message}" is blocked (internal/loopback)${why ? `: ${why}` : ''}`)
  );
  error.statusCode = 400;
  return error;
}

/** @param {string} ip @returns {number[] | null} dotted IPv4 → octet array */
function parseDottedV4(ip) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const octets = match.slice(1, 5).map(Number);
  return octets.some((n) => n > 255) ? null : octets;
}

/** @param {number[]} octets @returns {boolean} private/reserved/loopback IPv4 */
function isBlockedV4(octets) {
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
 * Normalize a hostname that is actually a numeric IPv4 (dotted, decimal, hex, or
 * octal) into octets. Returns null when the host is not a bare numeric IPv4.
 * @param {string} host @returns {number[] | null}
 */
export function numericHostToV4(host) {
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

/** @param {string} ip @returns {boolean} true when the literal IP is private/reserved/loopback */
export function isBlockedIp(ip) {
  const dotted = parseDottedV4(ip);
  if (dotted) return isBlockedV4(dotted);
  if (net.isIP(ip) === 6) {
    const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (lower === '::1' || lower === '::') return true;
    const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
    if (mapped) {
      const octets = parseDottedV4(mapped[1]);
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
 * Assert a URL hostname is safe to fetch — it must resolve only to public
 * addresses. Throws an Error whose message contains "blocked" otherwise.
 * @param {string} hostname
 * @param {{ lookupImpl?: (host: string) => Promise<unknown> | unknown }} [options]
 * @returns {Promise<void>}
 */
export async function assertPublicHost(hostname, { lookupImpl } = {}) {
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
    const address = typeof record === 'string' ? record : record && /** @type {{ address?: unknown }} */ (record).address;
    if (!address || isBlockedIp(String(address))) {
      throw blocked(host, `resolves to blocked address ${address}`);
    }
  }
}
