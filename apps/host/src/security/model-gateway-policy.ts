// Administrator-owned model gateway host policy (host L0 security).
import net from 'node:net';

export type RuntimeEnv = Record<string, string | undefined>;

function splitList(value: unknown): string[] {
  return String(value || '').trim()
    .split(/[,\s;]+/g)
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

function privateIpv4(host: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && Number(b) >= 16 && Number(b) <= 31) || (a === 192 && b === 168);
}

export function isPrivateModelHost(host: string): boolean {
  const value = host.replace(/^\[|\]$/g, '').toLowerCase();
  return privateIpv4(value)
    || /^f[cd][0-9a-f]{2}(?::|$)/.test(value)
    || /^fe[c-f][0-9a-f](?::|$)/.test(value)
    || value.endsWith('.internal')
    || value.endsWith('.corp')
    || value.endsWith('.local')
    || value.endsWith('.lan');
}

function canonicalHost(value: string): string {
  return value.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

/** Plain entries are exact. Only a leading `*.` grants strict subdomain
 * matching; malformed wildcard/URL/credential/path/port forms are ignored. */
export function isCustomerGatewayHostAllowed(
  host: string,
  env: RuntimeEnv = process.env as RuntimeEnv,
): boolean {
  const candidate = canonicalHost(host);
  if (!candidate) return false;
  return splitList(env.KCW_CUSTOMER_MODEL_GATEWAY_HOSTS).some((entry) => {
    const wildcard = entry.startsWith('*.');
    const rawPattern = wildcard ? entry.slice(2) : entry;
    if (!rawPattern || rawPattern.includes('*') || /[\/@?#]/.test(rawPattern)) return false;
    const pattern = canonicalHost(rawPattern);
    if (!pattern || (pattern.includes(':') && net.isIP(pattern) !== 6)) return false;
    if (wildcard && net.isIP(pattern)) return false;
    return wildcard
      ? candidate !== pattern && candidate.endsWith(`.${pattern}`)
      : candidate === pattern;
  });
}
