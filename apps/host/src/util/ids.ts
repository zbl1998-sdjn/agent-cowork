// 确定性随机/ID 源(host · L0 基础层,无内部依赖)
// ---------------------------------------------------------------------------
// 职责:提供「可由 seed 复现」的随机数、随机十六进制、随机字节与日期。用于回放
//       (replay)与评测(eval):同一 seed → 同一序列,使运行结果可重现、可断言。
// 依赖:无。导出:createSeededRandom / randomHex / seededRandomBytes /
//       seededDate / createSeededIdSource。
// 实现:FNV-1a 把 seed 哈希成 32 位种子,再用线性同余(LCG)推进序列。

const HEX_CHUNK = 0x100000000;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const LCG_A = 1664525;
const LCG_C = 1013904223;
const REPLAY_EPOCH_MS = Date.UTC(2026, 0, 1);
const REPLAY_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

export type RandomSource = () => number;

export type SeededIdSource = {
  random: RandomSource;
  randomHex: (length: number) => string;
  randomBytes: (size: number) => Buffer;
  date: () => Date;
};

// 用 FNV-1a 把任意 seed 哈希成非零的 32 位无符号整数,作为 LCG 初始状态。
function hashSeed(seed: unknown): number {
  const text = String(seed || 'seed');
  let hash = FNV_OFFSET;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return (hash >>> 0) || FNV_OFFSET;
}

export function createSeededRandom(seed: unknown): RandomSource {
  let state = hashSeed(seed);
  return () => {
    state = (Math.imul(state, LCG_A) + LCG_C) >>> 0;
    return state / HEX_CHUNK;
  };
}

export function randomHex(length: number, random: RandomSource = Math.random): string {
  const target = Math.max(0, Math.floor(Number(length) || 0));
  let out = '';
  while (out.length < target) {
    out += Math.floor(random() * HEX_CHUNK).toString(16).padStart(8, '0');
  }
  return out.slice(0, target);
}

export function seededRandomBytes(size: number, random: RandomSource): Buffer {
  const bytes = Array.from({ length: Math.max(0, Math.floor(Number(size) || 0)) }, () => Math.floor(random() * 256) & 0xff);
  return Buffer.from(bytes);
}

export function seededDate(seed: unknown): Date {
  const offset = hashSeed(`date:${String(seed || 'seed')}`) % REPLAY_WINDOW_MS;
  return new Date(REPLAY_EPOCH_MS + offset);
}

export function createSeededIdSource(seed: unknown): SeededIdSource {
  const text = String(seed || 'seed');
  const random = createSeededRandom(text);
  return {
    random,
    randomHex: (length) => randomHex(length, random),
    randomBytes: (size) => seededRandomBytes(size, random),
    date: () => seededDate(text),
  };
}
