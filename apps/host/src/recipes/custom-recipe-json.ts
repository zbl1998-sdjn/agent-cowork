// Bounded plain-JSON cloning for custom recipes (host · L1 · recipes).
import { types as utilTypes } from 'node:util';
import {
  isSensitiveFieldName,
  REDACTED_VALUE,
  redactText,
} from '../security/redaction.js';

const MAX_DEPTH = 16;
const MAX_NODES = 4_096;
const MAX_ARRAY_LENGTH = 256;
const MAX_OBJECT_KEYS = 128;
const MAX_STRING_LENGTH = 16_384;
const MAX_KEY_LENGTH = 256;
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const INVALID_JSON = 'custom recipe JSON is invalid or exceeds safety limits';

export type CustomRecipeJsonMode = 'sanitize' | 'validate';

type CloneState = {
  mode: CustomRecipeJsonMode;
  nodes: number;
  seen: WeakSet<object>;
};

function invalidJson(): Error {
  return new Error(INVALID_JSON);
}

function safeString(value: string, state: CloneState): string {
  if (value.length > MAX_STRING_LENGTH) throw invalidJson();
  const sanitized = redactText(value);
  if (typeof sanitized !== 'string') throw invalidJson();
  if (state.mode === 'validate' && sanitized !== value) throw invalidJson();
  return sanitized;
}

function enter(value: object, depth: number, state: CloneState): void {
  if (depth > MAX_DEPTH || state.seen.has(value)) throw invalidJson();
  state.seen.add(value);
}

function cloneArray(value: unknown[], depth: number, state: CloneState): unknown[] {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidJson();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_ARRAY_LENGTH) {
    throw invalidJson();
  }
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== length + 1) {
    throw invalidJson();
  }
  const result: unknown[] = [];
  for (let index = 0; index < length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidJson();
    result.push(cloneJson(descriptor.value, depth + 1, state));
  }
  if (keys.some((key) => (
    typeof key !== 'string'
    || (key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key))
  ))) throw invalidJson();
  return result;
}

function cloneObject(value: object, depth: number, state: CloneState): Record<string, unknown> {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw invalidJson();
  const keys = Reflect.ownKeys(value);
  if (keys.length > MAX_OBJECT_KEYS || keys.some((key) => typeof key !== 'string')) {
    throw invalidJson();
  }
  const result: Record<string, unknown> = {};
  for (const rawKey of keys as string[]) {
    if (rawKey.length > MAX_KEY_LENGTH || DANGEROUS_KEYS.has(rawKey.toLowerCase())) {
      throw invalidJson();
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, rawKey);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw invalidJson();
    const key = safeString(rawKey, state);
    if (DANGEROUS_KEYS.has(key.toLowerCase()) || Object.hasOwn(result, key)) throw invalidJson();
    if (isSensitiveFieldName(rawKey)) {
      if (state.mode === 'validate') {
        if (descriptor.value !== REDACTED_VALUE) throw invalidJson();
      } else {
        cloneJson(descriptor.value, depth + 1, state);
      }
      result[key] = REDACTED_VALUE;
    } else {
      result[key] = cloneJson(descriptor.value, depth + 1, state);
    }
  }
  return result;
}

function cloneJson(value: unknown, depth: number, state: CloneState): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_NODES || depth > MAX_DEPTH) throw invalidJson();
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') return safeString(value, state);
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalidJson();
    return value;
  }
  if (typeof value !== 'object' || utilTypes.isProxy(value)) throw invalidJson();
  enter(value, depth, state);
  return Array.isArray(value)
    ? cloneArray(value, depth, state)
    : cloneObject(value, depth, state);
}

export function createCustomRecipeJsonCloner(
  mode: CustomRecipeJsonMode,
): (value: unknown) => unknown {
  const state: CloneState = { mode, nodes: 0, seen: new WeakSet() };
  return (value: unknown): unknown => cloneJson(value, 0, state);
}
