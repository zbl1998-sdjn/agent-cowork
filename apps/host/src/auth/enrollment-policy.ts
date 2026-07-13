// 一次性注册能力(host · L1 领域层 · auth)
// ---------------------------------------------------------------------------
// 职责:把“能连到 loopback”与“获准创建新身份”分离。能力由运维/桌面外壳注入，
//      只在进程内保存并原子消费一次；不会写盘、回显或进入日志。
import { timingSafeEqual } from 'node:crypto';

export type EnrollmentPolicy = {
  consume(candidate: unknown): boolean;
};

export function createEnrollmentPolicy(token: unknown): EnrollmentPolicy {
  const expected = typeof token === 'string' ? token.trim() : '';
  if (expected && expected.length < 32) {
    throw new Error('KCW_ENROLLMENT_TOKEN must contain at least 32 characters');
  }
  let consumed = false;

  return {
    consume(candidate: unknown): boolean {
      if (consumed || !expected || typeof candidate !== 'string') return false;
      const supplied = candidate.trim();
      const expectedBytes = Buffer.from(expected, 'utf8');
      const suppliedBytes = Buffer.from(supplied, 'utf8');
      if (expectedBytes.length !== suppliedBytes.length) return false;
      if (!timingSafeEqual(expectedBytes, suppliedBytes)) return false;
      consumed = true;
      return true;
    },
  };
}
