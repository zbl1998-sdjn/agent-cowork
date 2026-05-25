// @ts-check

const HEX_CHUNK = 0x100000000;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const LCG_A = 1664525;
const LCG_C = 1013904223;
const REPLAY_EPOCH_MS = Date.UTC(2026, 0, 1);
const REPLAY_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

/**
 * @param {unknown} seed
 * @returns {number}
 */
function hashSeed(seed) {
  const text = String(seed || 'seed');
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) || FNV_OFFSET;
}

/**
 * @param {unknown} seed
 * @returns {() => number}
 */
export function createSeededRandom(seed) {
  let state = hashSeed(seed);
  return () => {
    state = (Math.imul(state, LCG_A) + LCG_C) >>> 0;
    return state / HEX_CHUNK;
  };
}

/**
 * @param {number} length
 * @param {() => number} [random]
 * @returns {string}
 */
export function randomHex(length, random = Math.random) {
  const target = Math.max(0, Math.floor(Number(length) || 0));
  let out = '';
  while (out.length < target) {
    out += Math.floor(random() * HEX_CHUNK).toString(16).padStart(8, '0');
  }
  return out.slice(0, target);
}

/**
 * @param {number} size
 * @param {() => number} random
 * @returns {Buffer}
 */
export function seededRandomBytes(size, random) {
  const bytes = Array.from({ length: Math.max(0, Math.floor(Number(size) || 0)) }, () => Math.floor(random() * 256) & 0xff);
  return Buffer.from(bytes);
}

/**
 * @param {unknown} seed
 * @returns {Date}
 */
export function seededDate(seed) {
  const offset = hashSeed(`date:${String(seed || 'seed')}`) % REPLAY_WINDOW_MS;
  return new Date(REPLAY_EPOCH_MS + offset);
}

/**
 * @param {unknown} seed
 */
export function createSeededIdSource(seed) {
  const text = String(seed || 'seed');
  const random = createSeededRandom(text);
  return {
    random,
    /** @param {number} length */
    randomHex: (length) => randomHex(length, random),
    /** @param {number} size */
    randomBytes: (size) => seededRandomBytes(size, random),
    date: () => seededDate(text),
  };
}
