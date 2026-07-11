// Collision-safe idempotency cache keys (host · L2 · runtime).
import {
  identityScopeTupleKey,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';

export type IdempotencyContext = {
  tenantId?: string;
  userId?: string;
  idempotencyKey?: string;
};

export function idempotencyCacheKey(
  context: IdempotencyContext,
  method: string,
  pathname: string,
): string {
  if (!context.idempotencyKey) return '';
  const owner = requireIdentityScopeFrom(context, { label: 'idempotency identity' });
  return identityScopeTupleKey(
    owner,
    'idempotency',
    method,
    pathname,
    context.idempotencyKey,
  );
}
