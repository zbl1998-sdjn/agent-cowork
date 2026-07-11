// Schedule route validation and visibility helpers (host · L3 · routes).
import { z } from 'zod';
import { bodyFingerprint } from '../http/request-utils.js';
import {
  canonicalRequiredIdentityScope,
  requireIdentityScopeFrom,
  type IdentityScope,
} from '../security/identity-scope.js';
import type { ScheduleRecord } from '../runtime/scheduler.js';

type ScheduleRouteContext = { tenantId: string; userId?: string; [key: string]: unknown };

const objectBody = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
);
const stringOrNullSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().nullable().optional(),
);
const payloadSchema = z.preprocess(
  (value) => (value == null ? {} : value),
  z.object({}).loose(),
);

export const scheduleCreateBodySchema = z.preprocess(objectBody, z.object({
  name: z.string().trim().min(1, 'name is required'),
  cron: stringOrNullSchema,
  fireAt: stringOrNullSchema,
  payload: payloadSchema,
}).loose());

export function scheduleOwner(context: ScheduleRouteContext): IdentityScope {
  return requireIdentityScopeFrom(context, { label: 'schedule route identity' });
}

export function scheduleVisibleToContext(
  record: ScheduleRecord | null | undefined,
  owner: IdentityScope,
): boolean {
  if (!record) return false;
  const recordOwner = canonicalRequiredIdentityScope(record.tenantId, record.userId);
  return Boolean(recordOwner)
    && recordOwner?.tenantId === owner.tenantId
    && recordOwner.userId === owner.userId;
}

export function emptyBodyFingerprint(): string {
  return bodyFingerprint({});
}

export function zodMessage(err: z.ZodError, fallback: string): string {
  return err.issues[0]?.message || fallback;
}
