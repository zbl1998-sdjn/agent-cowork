import { createHash } from 'node:crypto';
import type { AgentId, ContextRef, JsonObject } from './types.js';

export type FileSummaryCacheKey = {
  fileHash: string;
  skillId: string;
  agentId: AgentId;
};

export type FileSummaryCacheEntry = FileSummaryCacheKey & {
  cacheKey: string;
  summary: string;
  sourceRefId: string;
  label: string;
  uri: string;
  charLength: number;
  byteLength: number;
  createdAt: string;
  lastUsedAt: string;
  hits: number;
};

export type FileSummaryCacheResolution = {
  refs: ContextRef[];
  hits: number;
  misses: number;
  stores: number;
  cacheKeys: string[];
};

export type FileSummaryCacheOptions = {
  maxSummaryChars?: number;
  now?: () => Date;
};

export type ResolveFileSummaryRefsInput = {
  refs: readonly ContextRef[];
  skillId: string;
  agentId: AgentId;
};

export class FileSummaryCache {
  private readonly entries = new Map<string, FileSummaryCacheEntry>();
  private readonly maxSummaryChars: number;
  private readonly now: () => Date;

  constructor({ maxSummaryChars = 1200, now = () => new Date() }: FileSummaryCacheOptions = {}) {
    this.maxSummaryChars = Math.max(64, maxSummaryChars);
    this.now = now;
  }

  resolveRefs({ refs, skillId, agentId }: ResolveFileSummaryRefsInput): FileSummaryCacheResolution {
    let hits = 0;
    let misses = 0;
    let stores = 0;
    const cacheKeys: string[] = [];
    const resolved = refs.map((ref) => {
      if (ref.kind !== 'file') {
        return cloneRef(ref);
      }
      const fileHash = hashFileRef(ref);
      const cacheKey = buildFileSummaryCacheKey({ fileHash, skillId, agentId });
      cacheKeys.push(cacheKey);
      const found = this.entries.get(cacheKey);
      if (found) {
        hits += 1;
        found.hits += 1;
        found.lastUsedAt = this.now().toISOString();
        return withCacheMetadata(ref, found.summary, {
          hit: true,
          cacheKey,
          fileHash,
          skillId,
          agentId,
          summaryChars: found.summary.length,
        });
      }

      misses += 1;
      stores += 1;
      const summary = deriveSummary(ref, this.maxSummaryChars);
      const createdAt = this.now().toISOString();
      this.entries.set(cacheKey, {
        cacheKey,
        fileHash,
        skillId,
        agentId,
        summary,
        sourceRefId: ref.refId,
        label: ref.label,
        uri: ref.uri,
        charLength: ref.text.length,
        byteLength: Buffer.byteLength(ref.text, 'utf8'),
        createdAt,
        lastUsedAt: createdAt,
        hits: 0,
      });
      return withCacheMetadata(ref, summary, {
        hit: false,
        cacheKey,
        fileHash,
        skillId,
        agentId,
        summaryChars: summary.length,
      });
    });

    return { refs: resolved, hits, misses, stores, cacheKeys };
  }

  get(cacheKey: string): FileSummaryCacheEntry | null {
    const entry = this.entries.get(cacheKey);
    return entry ? { ...entry } : null;
  }

  size(): number {
    return this.entries.size;
  }
}

export function hashFileRef(ref: ContextRef): string {
  return createHash('sha256')
    .update(ref.uri || ref.label)
    .update('\0')
    .update(ref.text || ref.summary)
    .digest('hex');
}

export function buildFileSummaryCacheKey({ fileHash, skillId, agentId }: FileSummaryCacheKey): string {
  return `${skillId}:${agentId}:${fileHash}`;
}

function deriveSummary(ref: ContextRef, maxSummaryChars: number): string {
  const existing = ref.summary.trim();
  if (existing) {
    return existing.slice(0, maxSummaryChars);
  }
  const normalized = ref.text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxSummaryChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxSummaryChars - 3))}...`;
}

function cloneRef(ref: ContextRef): ContextRef {
  return { ...ref, dataTags: [...ref.dataTags], metadata: { ...ref.metadata } };
}

function withCacheMetadata(
  ref: ContextRef,
  summary: string,
  cache: JsonObject,
): ContextRef {
  return {
    ...ref,
    summary,
    dataTags: [...ref.dataTags],
    metadata: {
      ...ref.metadata,
      summaryCache: cache,
    },
  };
}