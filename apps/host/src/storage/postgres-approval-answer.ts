// Lossless question-answer envelope for PostgreSQL TEXT storage (host · L1).
// Only plain JSON data is accepted. Exotic objects, reflection hazards, and
// values whose identity/type JSON cannot preserve fail closed before a query.
import { types as utilTypes } from 'node:util';

export const POSTGRES_APPROVAL_ANSWER_MAX_BYTES = 64 * 1024;

const MAX_DEPTH = 32;
const MAX_NODES = 10_000;
const DANGEROUS_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const INVALID_ANSWER =
  'PostgresApprovalStore: question answer must be canonical JSON';
const INVALID_ENVELOPE =
  'PostgresApprovalStore: persisted question answer envelope is invalid';

class ApprovalAnswerError extends Error {}

function invalidAnswer(): ApprovalAnswerError {
  return new ApprovalAnswerError(INVALID_ANSWER);
}

function answerTooLarge(): ApprovalAnswerError {
  return new ApprovalAnswerError(
    `PostgresApprovalStore: question answer exceeds ${POSTGRES_APPROVAL_ANSWER_MAX_BYTES}-byte limit`,
  );
}

function invalidEnvelope(): ApprovalAnswerError {
  return new ApprovalAnswerError(INVALID_ENVELOPE);
}

function quote(value: string): string {
  const encoded = JSON.stringify(value);
  if (typeof encoded !== 'string') throw invalidAnswer();
  return encoded;
}

type SerializationState = {
  depth: number;
  counter: { nodes: number };
  seen: WeakSet<object>;
};

function descend(state: SerializationState, value: object): SerializationState {
  if (state.depth >= MAX_DEPTH || state.seen.has(value)) {
    throw invalidAnswer();
  }
  state.seen.add(value);
  return {
    depth: state.depth + 1,
    counter: state.counter,
    seen: state.seen,
  };
}

function serializeArray(value: unknown[], state: SerializationState): string {
  if (Object.getPrototypeOf(value) !== Array.prototype) throw invalidAnswer();
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  const length = lengthDescriptor?.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_NODES) throw invalidAnswer();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== length + 1) {
    throw invalidAnswer();
  }
  const parts: string[] = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalidAnswer();
    }
    parts.push(serializeJson(descriptor.value, state));
  }
  if (keys.some((key) => (
    typeof key !== 'string'
    || (key !== 'length' && !/^(0|[1-9][0-9]*)$/u.test(key))
  ))) {
    throw invalidAnswer();
  }
  return `[${parts.join(',')}]`;
}

function serializeObject(value: object, state: SerializationState): string {
  if (Object.getPrototypeOf(value) !== Object.prototype) throw invalidAnswer();
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string')) throw invalidAnswer();
  const parts: string[] = [];
  for (const key of keys as string[]) {
    if (DANGEROUS_KEYS.has(key)) throw invalidAnswer();
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw invalidAnswer();
    }
    parts.push(`${quote(key)}:${serializeJson(descriptor.value, state)}`);
  }
  return `{${parts.join(',')}}`;
}

function serializeJson(value: unknown, state: SerializationState): string {
  state.counter.nodes += 1;
  if (state.counter.nodes > MAX_NODES) throw invalidAnswer();
  if (value === null) return 'null';
  if (typeof value === 'string') return quote(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) throw invalidAnswer();
    return String(value);
  }
  if (typeof value !== 'object') throw invalidAnswer();
  if (utilTypes.isProxy(value)) throw invalidAnswer();
  const childState = descend(state, value);
  return Array.isArray(value)
    ? serializeArray(value, childState)
    : serializeObject(value, childState);
}

function serializeAnswer(value: unknown): string {
  return serializeJson(value, {
    depth: 0,
    counter: { nodes: 0 },
    seen: new WeakSet(),
  });
}

export function encodePostgresApprovalAnswer(value: unknown): string {
  try {
    const encoded = `{"v":1,"value":${serializeAnswer(value)}}`;
    if (Buffer.byteLength(encoded, 'utf8') > POSTGRES_APPROVAL_ANSWER_MAX_BYTES) {
      throw answerTooLarge();
    }
    return encoded;
  } catch (error) {
    if (error instanceof ApprovalAnswerError) throw error;
    throw invalidAnswer();
  }
}

export function decodePostgresApprovalAnswer(value: unknown): unknown {
  try {
    if (
      typeof value !== 'string'
      || Buffer.byteLength(value, 'utf8') > POSTGRES_APPROVAL_ANSWER_MAX_BYTES
    ) {
      throw invalidEnvelope();
    }
    const envelope: unknown = JSON.parse(value);
    if (
      envelope === null
      || typeof envelope !== 'object'
      || Array.isArray(envelope)
      || utilTypes.isProxy(envelope)
      || Object.getPrototypeOf(envelope) !== Object.prototype
    ) {
      throw invalidEnvelope();
    }
    const keys = Reflect.ownKeys(envelope);
    if (
      keys.length !== 2
      || !keys.includes('v')
      || !keys.includes('value')
      || keys.some((key) => typeof key !== 'string')
    ) {
      throw invalidEnvelope();
    }
    const version = Object.getOwnPropertyDescriptor(envelope, 'v');
    const answer = Object.getOwnPropertyDescriptor(envelope, 'value');
    if (
      !version
      || !answer
      || !Object.hasOwn(version, 'value')
      || !Object.hasOwn(answer, 'value')
      || version.value !== 1
    ) {
      throw invalidEnvelope();
    }
    const canonical = encodePostgresApprovalAnswer(answer.value);
    if (canonical !== value) throw invalidEnvelope();
    return answer.value;
  } catch {
    throw invalidEnvelope();
  }
}
