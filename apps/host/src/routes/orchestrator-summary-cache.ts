import { FileSummaryCache } from '../orchestrator/index.js';

type CacheContext = { tenantId?: string };

const DEFAULT_FILE_SUMMARY_CACHES = new Map<string, FileSummaryCache>();

export function defaultFileSummaryCacheFor(context: CacheContext): FileSummaryCache {
  const tenantId = String(context.tenantId || 'tenant_local');
  const existing = DEFAULT_FILE_SUMMARY_CACHES.get(tenantId);
  if (existing) return existing;
  const created = new FileSummaryCache();
  DEFAULT_FILE_SUMMARY_CACHES.set(tenantId, created);
  return created;
}