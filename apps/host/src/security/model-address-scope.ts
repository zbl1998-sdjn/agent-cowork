// Model address scope classification (host · L0 security).
// ---------------------------------------------------------------------------
// Pure IP-range classification for the model endpoint boundary. Split out of
// model-endpoint-request.ts to keep that file within the file-size budget;
// behaviour is unchanged. Private ranges are only usable by an explicitly
// allowlisted customer gateway; blocked ranges are never usable.
import net from 'node:net';

export type ModelAddressScope = 'public' | 'private' | 'loopback' | 'blocked';

function ipv4Parts(address: string): [number, number, number, number] | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return null;
  const parts = match.slice(1).map(Number) as [number, number, number, number];
  return parts.some((part) => part < 0 || part > 255) ? null : parts;
}

/** Classifies addresses for model routing. Private ranges are only usable by
 * an explicitly allowlisted customer gateway; blocked ranges are never usable. */
export function modelAddressScope(rawAddress: string): ModelAddressScope {
  const address = String(rawAddress || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const v4 = ipv4Parts(address);
  if (v4) {
    const [a, b, c] = v4;
    if (a === 127) return 'loopback';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'private';
    if (address === '100.100.100.200') return 'blocked';
    if ((a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))) return 'private';
    if (a === 0 || (a === 169 && b === 254) || a >= 224) return 'blocked';
    if ((a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113)) return 'blocked';
    return 'public';
  }
  if (net.isIP(address) !== 6) return 'blocked';
  if (address === '::1') return 'loopback';
  if (address === '::' || address.startsWith('::ffff:')) return 'blocked';
  if (address === 'fd00:ec2::254') return 'blocked';
  if (/^f[cd][0-9a-f]{2}(?::|$)/.test(address) || /^fe[c-f][0-9a-f](?::|$)/.test(address)) return 'private';
  if (/^fe[89ab][0-9a-f](?::|$)/.test(address) || /^ff[0-9a-f]{2}(?::|$)/.test(address)) return 'blocked';
  if (/^2001:0?db8(?::|$)/.test(address)) return 'blocked';
  return 'public';
}
