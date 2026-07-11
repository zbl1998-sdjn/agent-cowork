// GitHub JSON/viewer DTO boundary (host · L1 · connectors).
import { types as utilTypes } from 'node:util';

export type JsonObject = Record<string, unknown>;
export type GitHubViewer = {
  login: string;
  id: string | number | null;
  name: string | null;
  email: string | null;
};

const MAX_LOGIN_LENGTH = 256;
const MAX_VIEWER_FIELD_LENGTH = 1_024;

export function asJsonObject(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) || Array.isArray(value)) return {};
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as JsonObject : {};
}

export function stringField(payload: JsonObject, key: string): string {
  const descriptor = Object.getOwnPropertyDescriptor(payload, key);
  const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
  return typeof value === 'string' ? value : '';
}

function boundedString(value: unknown, maxLength: number, trim = false): string | null {
  if (typeof value !== 'string') return null;
  const normalized = trim ? value.trim() : value;
  return normalized.length > 0 && normalized.length <= maxLength ? normalized : null;
}

function dataField(payload: JsonObject, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(payload, key);
  return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

export function githubViewerDto(value: unknown): GitHubViewer {
  const payload = asJsonObject(value);
  const id = dataField(payload, 'id');
  return {
    login: boundedString(dataField(payload, 'login'), MAX_LOGIN_LENGTH, true) || 'github-user',
    id: (
      (typeof id === 'number' && Number.isSafeInteger(id) && !Object.is(id, -0))
      || boundedString(id, MAX_VIEWER_FIELD_LENGTH) !== null
    ) ? id as string | number : null,
    name: boundedString(dataField(payload, 'name'), MAX_VIEWER_FIELD_LENGTH),
    email: boundedString(dataField(payload, 'email'), MAX_VIEWER_FIELD_LENGTH),
  };
}
