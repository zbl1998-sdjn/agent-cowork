// @ts-check
//
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

/**
 * 用 FNV-1a 把任意 seed 哈希成非零的 32 位无符号整数,作为 LCG 的初始状态。
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
 * 由 seed 造一个确定性 [0,1) 随机函数(LCG),替代 Math.random 以保证可复现。
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
 * 生成指定长度的十六进制字符串;默认用 Math.random,传入 seeded random 即可复现。
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
 * 由确定性 random 生成 size 字节的 Buffer(可复现的随机字节)。
 * @param {number} size
 * @param {() => number} random
 * @returns {Buffer}
 */
export function seededRandomBytes(size, random) {
  const bytes = Array.from({ length: Math.max(0, Math.floor(Number(size) || 0)) }, () => Math.floor(random() * 256) & 0xff);
  return Buffer.from(bytes);
}

/**
 * 由 seed 推出一个落在固定一年窗口内的确定性日期(回放时间戳稳定可断言)。
 * @param {unknown} seed
 * @returns {Date}
 */
export function seededDate(seed) {
  const offset = hashSeed(`date:${String(seed || 'seed')}`) % REPLAY_WINDOW_MS;
  return new Date(REPLAY_EPOCH_MS + offset);
}

/**
 * 把上述能力打包成一个「确定性 ID 源」:统一持有一个 random,产出 hex/bytes/date。
 * 供回放/评测注入,替换运行时默认的非确定性随机源。
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
