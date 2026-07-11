// Release evidence validators (scripts · pure validation)
// ---------------------------------------------------------------------------
// Validates installer names, updater configuration/round-trip reports, and
// CycloneDX structure without reading files or invoking external commands.

import path from 'node:path';

export type JsonRecord = Record<string, unknown>;

export type UpdaterConfigurationInspection = {
  configured: boolean;
  blockers: string[];
  endpoints: string[];
};

export type CycloneDxSummary = {
  componentCount: number;
  specVersion: string;
};

export type UpdaterRoundTripReport = {
  schemaVersion: 1;
  status: 'passed';
  version: string;
  endpoint: string;
  checkedAt: string;
  fromVersion: string;
  toVersion: string;
  updaterSignatureVerified: true;
  installedClientLaunched: true;
};

export const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const githubAttestationSbomLimitBytes = 16 * 1024 * 1024;

const placeholderUpdaterHosts = new Set(['localhost', '127.0.0.1', '::1']);

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function installerFileNameMatchesVersion(filePath: string, expectedVersion: string): boolean {
  const pattern = new RegExp(
    `(?:^|[^0-9A-Za-z])${escapeRegex(expectedVersion)}(?=$|[^0-9A-Za-z])`,
    'i',
  );
  return pattern.test(path.basename(filePath));
}

function isPlaceholderUpdaterEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return true;
  }
  const hostname = url.hostname.toLowerCase();
  return url.protocol !== 'https:'
    || placeholderUpdaterHosts.has(hostname)
    || hostname.endsWith('.local')
    || hostname.endsWith('.test')
    || hostname.endsWith('.example')
    || hostname.endsWith('.invalid');
}

export function inspectUpdaterConfiguration(value: unknown): UpdaterConfigurationInspection {
  const blockers: string[] = [];
  const config = isRecord(value) ? value : {};
  const bundle = isRecord(config.bundle) ? config.bundle : {};
  const plugins = isRecord(config.plugins) ? config.plugins : {};
  const updater = isRecord(plugins.updater) ? plugins.updater : {};

  if (bundle.createUpdaterArtifacts !== true) {
    blockers.push('Tauri bundle.createUpdaterArtifacts must be true for v2 updater artifacts.');
  }
  if (updater.dangerousInsecureTransportProtocol === true) {
    blockers.push('Tauri updater dangerousInsecureTransportProtocol must remain disabled.');
  }
  if (typeof updater.pubkey !== 'string' || !updater.pubkey.trim()) {
    blockers.push('Tauri updater public key is missing.');
  }

  const rawEndpoints = Array.isArray(updater.endpoints) ? updater.endpoints : [];
  const endpoints = Array.isArray(updater.endpoints)
    ? rawEndpoints.filter((endpoint): endpoint is string => (
      typeof endpoint === 'string' && Boolean(endpoint.trim())
    ))
    : [];
  if (endpoints.length === 0) blockers.push('Tauri updater endpoint list is empty.');
  if (rawEndpoints.length !== endpoints.length) {
    blockers.push('Tauri updater endpoints must all be non-empty strings.');
  }
  for (const endpoint of endpoints) {
    if (isPlaceholderUpdaterEndpoint(endpoint)) {
      blockers.push(`Tauri updater endpoint is insecure or a placeholder: ${endpoint}`);
    }
  }
  return { configured: blockers.length === 0, blockers, endpoints };
}

export function validateCycloneDxSbom(value: unknown): CycloneDxSummary {
  if (!isRecord(value) || value.bomFormat !== 'CycloneDX') {
    throw new Error('SBOM must be a CycloneDX JSON document');
  }
  const specVersion = requiredString(value.specVersion, 'CycloneDX specVersion');
  if (!/^1\.(?:5|6|7)$/.test(specVersion)) {
    throw new Error(`Unsupported CycloneDX specVersion: ${specVersion}`);
  }
  const serialNumber = requiredString(value.serialNumber, 'CycloneDX serialNumber');
  if (!/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(serialNumber)) {
    throw new Error('CycloneDX serialNumber must be a UUID URN');
  }
  if (!isRecord(value.metadata)) throw new Error('CycloneDX metadata is missing');
  const timestamp = requiredString(value.metadata.timestamp, 'CycloneDX metadata.timestamp');
  if (!/^\d{4}-\d{2}-\d{2}T/.test(timestamp) || !Number.isFinite(Date.parse(timestamp))) {
    throw new Error('CycloneDX metadata.timestamp must be a valid RFC 3339 timestamp');
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error('CycloneDX SBOM must contain at least one component');
  }

  const references = new Set<string>();
  for (const [index, componentValue] of value.components.entries()) {
    if (!isRecord(componentValue)) {
      throw new Error(`CycloneDX component ${index} must be an object`);
    }
    requiredString(componentValue.type, `CycloneDX component ${index}.type`);
    requiredString(componentValue.name, `CycloneDX component ${index}.name`);
    requiredString(componentValue.version, `CycloneDX component ${index}.version`);
    const reference = requiredString(
      componentValue['bom-ref'],
      `CycloneDX component ${index}.bom-ref`,
    );
    if (references.has(reference)) {
      throw new Error(`CycloneDX SBOM contains duplicate bom-ref: ${reference}`);
    }
    references.add(reference);
  }
  return { componentCount: value.components.length, specVersion };
}

export function validateUpdaterRoundTripReport(
  value: unknown,
  expectedVersion: string,
  configuredEndpoints: string[],
): UpdaterRoundTripReport {
  if (!isRecord(value)) throw new Error('Updater round-trip report must be a JSON object');
  if (value.schemaVersion !== 1) {
    throw new Error('Updater round-trip report schemaVersion must be 1');
  }
  if (value.status !== 'passed') {
    throw new Error('Updater round-trip report status must be passed');
  }
  const version = requiredString(value.version, 'Updater report version');
  const endpoint = requiredString(value.endpoint, 'Updater report endpoint');
  const checkedAt = requiredString(value.checkedAt, 'Updater report checkedAt');
  const fromVersion = requiredString(value.fromVersion, 'Updater report fromVersion');
  const toVersion = requiredString(value.toVersion, 'Updater report toVersion');
  if (![version, fromVersion, toVersion].every((candidate) => semverPattern.test(candidate))) {
    throw new Error('Updater round-trip versions must all be valid SemVer values');
  }
  if (version !== expectedVersion || toVersion !== expectedVersion) {
    throw new Error(`Updater round-trip version must match ${expectedVersion}`);
  }
  if (fromVersion === toVersion) {
    throw new Error('Updater round trip must move between two different versions');
  }
  if (isPlaceholderUpdaterEndpoint(endpoint)) {
    throw new Error(`Updater round-trip endpoint is insecure or a placeholder: ${endpoint}`);
  }

  const reportUrl = new URL(endpoint);
  const matchesConfiguredEndpoint = configuredEndpoints.some((configuredEndpoint) => {
    try {
      const configuredUrl = new URL(configuredEndpoint);
      if (configuredUrl.origin !== reportUrl.origin) return false;
      const templateIndex = configuredEndpoint.indexOf('{{');
      if (templateIndex < 0) return configuredUrl.pathname === reportUrl.pathname;
      const fixedPrefixUrl = new URL(configuredEndpoint.slice(0, templateIndex));
      return reportUrl.pathname.startsWith(fixedPrefixUrl.pathname);
    } catch {
      return false;
    }
  });
  if (!matchesConfiguredEndpoint) {
    throw new Error('Updater round-trip endpoint must match a configured updater endpoint');
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(checkedAt) || !Number.isFinite(Date.parse(checkedAt))) {
    throw new Error('Updater round-trip checkedAt must be a valid RFC 3339 timestamp');
  }
  if (value.updaterSignatureVerified !== true) {
    throw new Error('Updater round-trip evidence must prove updater signature verification');
  }
  if (value.installedClientLaunched !== true) {
    throw new Error('Updater round-trip evidence must prove the updated installed client launched');
  }
  return {
    schemaVersion: 1,
    status: 'passed',
    version,
    endpoint,
    checkedAt,
    fromVersion,
    toVersion,
    updaterSignatureVerified: true,
    installedClientLaunched: true,
  };
}
