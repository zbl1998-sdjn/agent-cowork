// Orchestrator security-mode adapter (host L3 routes).
// The HTTP body never owns this boundary; translate the host's authoritative
// L0 mode into the orchestration runtime's legacy three-mode vocabulary.
import { normalizeSecurityMode } from '../security/security-mode.js';
import type { SecurityMode } from '../orchestrator/index.js';

export function resolveOrchestratorSecurityMode(
  requestContext: { securityMode?: unknown },
): SecurityMode {
  const raw = String(requestContext.securityMode || '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if (raw === 'cloud_opt_in') return 'cloud_opt_in';
  const mode = normalizeSecurityMode(raw, 'local_strict');
  if (mode === 'enterprise_local') return 'enterprise_hybrid';
  if (mode === 'controlled_hybrid') return 'cloud_opt_in';
  return 'local_strict';
}
