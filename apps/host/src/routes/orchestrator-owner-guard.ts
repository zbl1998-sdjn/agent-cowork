// Orchestrator owner guard(host · L3 路由层 · routes)
// ---------------------------------------------------------------------------
// 职责:统一规范化 tenant/user owner,并在读取编排 run record 时执行精确主体授权。

import { sendJson } from '../http/request-utils.js';
import { readRunRecord, type RunRecord } from '../runtime/run-store.js';
import { normalizeRunOwner, sameRunOwner, type RunOwner } from '../util/run-owner.js';
import type { HttpResponseLike } from '../http/request-utils.js';

export type OrchestratorOwnerContext = {
  tenantId?: string;
  userId?: string;
};

type OwnerGuardOptions = {
  requestContext: OrchestratorOwnerContext;
  response: HttpResponseLike;
  runStoreRoot: string;
};

function hasOwnOwnerField(value: unknown): boolean {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && (
      Object.getOwnPropertyDescriptor(value, 'tenantId')
      || Object.getOwnPropertyDescriptor(value, 'userId')
    )
  );
}

function storedOrchestratorOwner(record: RunRecord): RunOwner | null {
  try {
    const contextDescriptor = Object.getOwnPropertyDescriptor(record, 'context');
    if (contextDescriptor && !Object.hasOwn(contextDescriptor, 'value')) return null;
    const context = contextDescriptor?.value;
    if (hasOwnOwnerField(context)) {
      return normalizeRunOwner(context, { label: 'Stored orchestrator owner' });
    }
    if (hasOwnOwnerField(record)) {
      return normalizeRunOwner(record, { label: 'Stored orchestrator owner' });
    }
    return null;
  } catch (error) {
    void error;
    return null;
  }
}

export function orchestratorOwner(requestContext: OrchestratorOwnerContext): RunOwner {
  return normalizeRunOwner(requestContext, { label: 'Orchestrator owner' });
}

export function visibleOrchestratorRecord(
  record: RunRecord | null | undefined,
  requestContext: OrchestratorOwnerContext,
): boolean {
  if (!record || record.type !== 'orchestrator') return false;
  const storedOwner = storedOrchestratorOwner(record);
  if (!storedOwner) return false;
  return sameRunOwner(storedOwner, orchestratorOwner(requestContext));
}

export function readOwnedOrchestratorRecord(
  options: OwnerGuardOptions,
  runId: string,
): RunRecord | null {
  const record = readRunRecord(options.runStoreRoot, runId);
  if (visibleOrchestratorRecord(record, options.requestContext)) return record;
  sendJson(options.response, 404, { error: 'Orchestrator run not found' });
  return null;
}
