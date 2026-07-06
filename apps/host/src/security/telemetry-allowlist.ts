// Telemetry allowlist sanitizer (host L0 security).

export type TelemetryPrimitive = string | number | boolean | null;
export type TelemetryValue = TelemetryPrimitive | TelemetryValue[] | { [key: string]: TelemetryValue };
export type TelemetrySanitizeResult = { payload: TelemetryValue; rejectedKeys: string[] };

export const TELEMETRY_ALLOWED_FIELDS = Object.freeze([
  'event',
  'type',
  'status',
  'ok',
  'service',
  'time',
  'count',
  'calls',
  'promptTokens',
  'cachedTokens',
  'hitRatePct',
  'distinctPrefixes',
  'prefixStable',
  'slot',
  'securityMode',
  'policyHash',
  'healthCode',
  'backend',
  'selectedBackend',
  'networkIsolated',
  'fallback',
  'providerClass',
  'decision',
  'reasonCode',
  'toolName',
  'riskLevel',
  'durationMs',
  'cache',
  'byKey',
  'sandbox',
  'policy',
  'model',
  'configured',
  'hasKey',
  'storeBackend',
  'postgres',
] as const);

const allowed = new Set<string>(TELEMETRY_ALLOWED_FIELDS);
const blockedKeyPattern = /^(?:prompt|content|message|path|file|root|cwd|home|raw|args|arguments|result|output|input|body|url|baseUrl|cacheKey|key)$/i;
const blockedSecretPattern = /(?:api.?key|secret|password|credential|bearer|authorization)/i;

function isPrimitive(value: unknown): value is TelemetryPrimitive {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function sanitize(value: unknown, rejectedKeys: string[], path = ''): TelemetryValue {
  if (isPrimitive(value)) return value;
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitize(item, rejectedKeys, `${path}[${index}]`));
  }
  if (!value || typeof value !== 'object') return null;
  const out: { [key: string]: TelemetryValue } = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${key}` : key;
    if (!allowed.has(key) || blockedKeyPattern.test(key) || blockedSecretPattern.test(key)) {
      rejectedKeys.push(childPath);
      continue;
    }
    out[key] = sanitize(item, rejectedKeys, childPath);
  }
  return out;
}

export function sanitizeTelemetryPayload(value: unknown): TelemetrySanitizeResult {
  const rejectedKeys: string[] = [];
  return {
    payload: sanitize(value, rejectedKeys),
    rejectedKeys,
  };
}
