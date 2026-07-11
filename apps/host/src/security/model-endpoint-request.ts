// Model endpoint connection boundary (host L0 security).
// Resolves once, validates every returned address, pins the selected address for
// the socket lookup, and never follows HTTP redirects. In-process fetch seams
// are trusted code capabilities; they still receive syntax/policy checks and
// redirect:error, but are not treated as proof of a real network connection.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import {
  classifyModelProvider,
  decideModelProviderPolicy,
  inspectModelBaseUrl,
  type ProviderClass,
  type RuntimeEnv,
} from './security-mode.js';

type LookupRecord = { address: string; family: number };
export type ModelLookup = (host: string) => Promise<unknown> | unknown;
export type ModelRequestInit = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  redirect?: 'error';
};
type ModelStreamReader = { read(): Promise<{ value?: Uint8Array; done?: boolean }> };
export type ModelFetchResponse = {
  ok: boolean;
  status: number;
  body?: { getReader(): ModelStreamReader } | null;
  json(): Promise<unknown>;
  text(): Promise<string>;
};
export type ModelFetch = (url: string, init?: ModelRequestInit) => Promise<ModelFetchResponse>;
type ModelFetchInput = (url: string, init?: ModelRequestInit) => Promise<Partial<ModelFetchResponse> & {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

export type ModelAddressScope = 'public' | 'private' | 'loopback' | 'blocked';

function endpointError(message: string, code = 'MODEL_ENDPOINT_BLOCKED'): Error & { code: string } {
  const error = new Error(`model endpoint blocked: ${message}`) as Error & { code: string };
  error.name = 'ModelEndpointPolicyError';
  error.code = code;
  return error;
}

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

function targetInspection(url: string, config: Record<string, unknown>, env: RuntimeEnv): {
  parsed: URL;
  providerClass: ProviderClass;
} {
  const target = inspectModelBaseUrl(url);
  if (!target.provided || target.issue) {
    throw endpointError(target.issue?.reason || 'invalid model endpoint URL');
  }
  const configured = inspectModelBaseUrl(config.baseUrl);
  if (configured.provided) {
    if (configured.issue) throw endpointError(configured.issue.reason);
    if (new URL(configured.normalized).origin !== new URL(target.normalized).origin) {
      throw endpointError('request URL does not match the configured model base URL origin');
    }
  }
  const candidate = { ...config, baseUrl: target.normalized };
  const policy = decideModelProviderPolicy(candidate, { securityMode: config.securityMode, env });
  if (policy.decision === 'deny') throw endpointError(policy.reason);
  return { parsed: new URL(target.normalized), providerClass: classifyModelProvider(candidate, { env }) };
}

function lookupRecords(value: unknown): LookupRecord[] {
  const list = Array.isArray(value) ? value : [value];
  return list.map((record) => {
    if (typeof record === 'string') return { address: record, family: net.isIP(record) };
    if (!record || typeof record !== 'object' || !('address' in record)) return { address: '', family: 0 };
    const item = record as { address?: unknown; family?: unknown };
    const address = String(item.address || '');
    const family = Number(item.family) || net.isIP(address);
    return { address, family };
  });
}

export async function resolveModelEndpoint(
  url: string,
  config: Record<string, unknown>,
  {
    env = process.env as RuntimeEnv,
    lookupImpl = (host) => dns.promises.lookup(host, { all: true, verbatim: true }),
  }: { env?: RuntimeEnv; lookupImpl?: ModelLookup } = {},
): Promise<{ url: URL; address: string; family: number; providerClass: ProviderClass }> {
  const target = targetInspection(url, config, env);
  let records: LookupRecord[];
  try {
    records = lookupRecords(await lookupImpl(target.parsed.hostname.replace(/^\[|\]$/g, '')));
  } catch {
    throw endpointError('DNS resolution failed');
  }
  if (!records.length || records.some((record) => !record.address || (record.family !== 4 && record.family !== 6))) {
    throw endpointError('DNS resolution returned no usable addresses');
  }
  for (const record of records) {
    const scope = modelAddressScope(record.address);
    if (scope === 'blocked') throw endpointError(`DNS resolved to blocked address ${record.address}`);
    if (target.providerClass === 'local' && scope !== 'loopback') {
      throw endpointError(`local model endpoint resolved outside loopback: ${record.address}`);
    }
    if (target.providerClass === 'external_provider' && scope !== 'public') {
      throw endpointError(`private DNS address is not allowed for an external provider: ${record.address}`);
    }
    if (target.providerClass === 'customer_gateway' && scope === 'loopback') {
      throw endpointError(`customer gateway resolved to loopback: ${record.address}`);
    }
  }
  const selected = records[0];
  if (!selected) throw endpointError('DNS resolution returned no usable addresses');
  return { url: target.parsed, address: selected.address, family: selected.family, providerClass: target.providerClass };
}

function streamReader(message: http.IncomingMessage): ModelStreamReader {
  const chunks: Uint8Array[] = [];
  let ended = false;
  let failure: Error | null = null;
  let wake: (() => void) | null = null;
  const signal = () => { const current = wake; wake = null; if (current) current(); };
  message.on('data', (chunk: Buffer | string) => { chunks.push(Buffer.from(chunk)); signal(); });
  message.on('end', () => { ended = true; signal(); });
  message.on('error', (error: Error) => { failure = error; signal(); });
  return {
    async read() {
      while (!chunks.length && !ended && !failure) await new Promise<void>((resolve) => { wake = resolve; });
      if (failure) throw failure;
      const value = chunks.shift();
      return value ? { value, done: false } : { done: true };
    },
  };
}

async function readText(reader: ModelStreamReader): Promise<string> {
  const chunks: Buffer[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

function requestPinned(resolved: Awaited<ReturnType<typeof resolveModelEndpoint>>, init: ModelRequestInit): Promise<ModelFetchResponse> {
  return new Promise((resolve, reject) => {
    const transport = resolved.url.protocol === 'https:' ? https : http;
    const request = transport.request(resolved.url, {
      method: init.method || 'GET',
      headers: init.headers || {},
      ...(init.signal ? { signal: init.signal } : {}),
      family: resolved.family,
      autoSelectFamily: false,
      lookup: (_host, _options, callback) => callback(null, resolved.address, resolved.family),
    }, (message) => {
      const reader = streamReader(message);
      const text = () => readText(reader);
      const status = Number(message.statusCode) || 0;
      resolve({
        ok: status >= 200 && status < 300,
        status,
        body: { getReader: () => reader },
        text,
        async json() { return JSON.parse(await text()) as unknown; },
      });
    });
    request.on('error', reject);
    if (init.body) request.write(init.body);
    request.end();
  });
}

function normalizedInjectedResponse(response: Awaited<ReturnType<ModelFetchInput>>): ModelFetchResponse {
  const text = typeof response.text === 'function'
    ? () => response.text?.() || Promise.resolve('')
    : async () => JSON.stringify(await response.json());
  return { ...response, body: response.body || null, text };
}

export function createModelEndpointFetch(
  config: Record<string, unknown>,
  {
    fetchImpl,
    env = process.env as RuntimeEnv,
    lookupImpl,
  }: { fetchImpl?: ModelFetchInput; env?: RuntimeEnv; lookupImpl?: ModelLookup } = {},
): ModelFetch {
  return async (url, init = {}) => {
    const target = targetInspection(url, config, env);
    if (fetchImpl && fetchImpl !== globalThis.fetch) {
      return normalizedInjectedResponse(await fetchImpl(target.parsed.href, { ...init, redirect: 'error' }));
    }
    const policy = decideModelProviderPolicy(
      { ...config, baseUrl: target.parsed.href },
      { securityMode: config.securityMode, env },
    );
    if (policy.decision !== 'allow') {
      throw endpointError(
        policy.reason,
        policy.decision === 'needs_approval' ? 'EGRESS_APPROVAL_REQUIRED' : 'MODEL_ENDPOINT_BLOCKED',
      );
    }
    const resolved = await resolveModelEndpoint(url, config, { env, ...(lookupImpl ? { lookupImpl } : {}) });
    return requestPinned(resolved, init);
  };
}
