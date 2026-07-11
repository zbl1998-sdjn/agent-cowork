import { FileSummaryCache } from '../orchestrator/index.js';
import {
  identityScopeTupleKey,
  requireIdentityScopeFrom,
} from '../security/identity-scope.js';

type CacheContext = { tenantId?: string; userId?: string };

const DEFAULT_FILE_SUMMARY_CACHES = new Map<string, FileSummaryCache>();

export function defaultFileSummaryCacheFor(context: CacheContext): FileSummaryCache {
  const owner = requireIdentityScopeFrom(context, { label: 'orchestrator summary cache identity' });
  const key = identityScopeTupleKey(owner, 'orchestrator-summary-cache');
  const existing = DEFAULT_FILE_SUMMARY_CACHES.get(key);
  if (existing) return existing;
  const created = new FileSummaryCache();
  DEFAULT_FILE_SUMMARY_CACHES.set(key, created);
  return created;
}
