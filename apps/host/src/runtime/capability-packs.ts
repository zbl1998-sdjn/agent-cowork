// 能力包目录(host · L2 运行时)
// ---------------------------------------------------------------------------
// 职责:把已有运行时依赖目录提升成 2.1 的 Capability/Role Pack 视图,用于推荐、
//       install plan 预检与 UI 展示。这里只生成可审查计划,不下载、不安装。
import { buildRuntimeDependencyInstallPlan } from './dependency-install-plan.js';
import { RUNTIME_DEPENDENCY_CATALOG } from './dependencies-catalog.js';
import type { RuntimeDependencyInstallPlanOptions } from './dependency-install-plan-types.js';
import {
  auditCapabilityPacks,
  type CapabilityPackManifest,
  type GovernedCapabilityPack,
} from '../skills/capability-pack-governance.js';
import { CAPABILITY_PACK_CATALOG } from '../skills/capability-pack-catalog.js';

export type {
  CapabilityPackAuditOptions,
  CapabilityPackCategory,
  CapabilityPackGovernance,
  CapabilityPackManifest,
  GovernedCapabilityPack,
} from '../skills/capability-pack-governance.js';
export type CapabilityPack = CapabilityPackManifest;

export type CapabilityRecommendation = GovernedCapabilityPack & {
  reason: string;
  missingDependencyIds: string[];
};

const knownDependencyIds = new Set(RUNTIME_DEPENDENCY_CATALOG.map((item) => item.id));

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function normalizeIds(value: unknown): string[] {
  return Array.isArray(value)
    ? unique(value.map((item) => String(item || '').trim()).filter(Boolean))
    : [];
}

function dependencyExists(id: string): boolean {
  return knownDependencyIds.has(id);
}

function governCapabilityPacks(
  manifests: readonly CapabilityPackManifest[],
): GovernedCapabilityPack[] {
  return auditCapabilityPacks(manifests, { knownDependencyIds });
}

export function listCapabilityPacks(): GovernedCapabilityPack[] {
  return governCapabilityPacks(CAPABILITY_PACK_CATALOG);
}

export function recommendCapabilityPacks(options: { role?: unknown; taskIntent?: unknown } = {}): CapabilityRecommendation[] {
  const role = String(options.role || '').trim().toLowerCase();
  const taskIntent = String(options.taskIntent || '').trim().toLowerCase();
  return listCapabilityPacks()
    .filter((pack) => {
      if (role && pack.recommendedForRoles.includes(role)) return true;
      if (/front|ui|react|design|视觉|前端/.test(taskIntent)) return pack.id === 'frontend-design-pack' || pack.id === 'browser-automation-pack';
      if (/pdf|ocr|扫描|合同|发票/.test(taskIntent)) return pack.id === 'pdf-ocr-pack';
      if (/csv|excel|data|数据|报表/.test(taskIntent)) return pack.id === 'data-analysis-pack';
      return pack.id === 'core-text-pack';
    })
    .map((pack) => ({
      ...pack,
      reason: role && pack.recommendedForRoles.includes(role) ? `匹配岗位 ${role}` : '匹配当前任务意图',
      // “missing” means absent from the managed dependency catalog; installed
      // state is intentionally not inferred from catalog membership.
      missingDependencyIds: pack.dependencyIds.filter((id) => !dependencyExists(id)),
    }));
}

function resolveCapabilityPacks(
  packs: readonly GovernedCapabilityPack[],
  packIds: unknown,
): {
  requestedPackIds: string[];
  resolvedPacks: GovernedCapabilityPack[];
  unknownPackIds: string[];
  missingRequiredPackIds: string[];
} {
  const requestedPackIds = normalizeIds(packIds);
  const packById = new Map(packs.map((pack) => [pack.id, pack]));
  const unknownPackIds: string[] = [];
  const missingRequiredPackIds: string[] = [];
  const resolvedPacks: GovernedCapabilityPack[] = [];
  const state = new Map<string, 'visiting' | 'visited'>();
  for (const id of requestedPackIds) {
    const rootPack = packById.get(id);
    if (!rootPack) {
      unknownPackIds.push(id);
      continue;
    }
    if (state.has(id)) continue;
    const stack = [{ pack: rootPack, requiredIds: normalizeIds(rootPack.requiredPackIds), nextRequiredIndex: 0 }];
    state.set(id, 'visiting');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) throw new Error('capability pack resolution stack invariant violated');
      if (frame.nextRequiredIndex >= frame.requiredIds.length) {
        state.set(frame.pack.id, 'visited');
        resolvedPacks.push(frame.pack);
        stack.pop();
        continue;
      }
      const requiredId = frame.requiredIds[frame.nextRequiredIndex];
      frame.nextRequiredIndex += 1;
      if (!requiredId) continue;
      const requiredPack = packById.get(requiredId);
      if (!requiredPack) {
        missingRequiredPackIds.push(requiredId);
        continue;
      }
      if (state.has(requiredId)) continue;
      state.set(requiredId, 'visiting');
      stack.push({
        pack: requiredPack,
        requiredIds: normalizeIds(requiredPack.requiredPackIds),
        nextRequiredIndex: 0,
      });
    }
  }

  return {
    requestedPackIds,
    resolvedPacks,
    unknownPackIds: unique(unknownPackIds),
    missingRequiredPackIds: unique(missingRequiredPackIds),
  };
}

export function dependencyIdsForPacks(packIds: unknown): { dependencyIds: string[]; unknownPackIds: string[] } {
  const resolved = resolveCapabilityPacks(listCapabilityPacks(), packIds);
  return {
    dependencyIds: unique(resolved.resolvedPacks.flatMap((pack) => pack.dependencyIds)),
    unknownPackIds: resolved.unknownPackIds,
  };
}

export function buildCapabilityInstallPlan(
  options: RuntimeDependencyInstallPlanOptions & { packIds?: unknown } = {},
  manifests: readonly CapabilityPackManifest[] = CAPABILITY_PACK_CATALOG,
) {
  const resolved = resolveCapabilityPacks(governCapabilityPacks(manifests), options.packIds);
  const selectedIds = unique([
    ...normalizeIds(options.selectedIds),
    ...resolved.resolvedPacks.flatMap((pack) => pack.dependencyIds),
  ]);
  const runtimePlan = buildRuntimeDependencyInstallPlan({ ...options, selectedIds });
  const blockedPackIds = resolved.resolvedPacks
    .filter((pack) => pack.governance.status === 'blocked')
    .map((pack) => pack.id);
  return {
    ok: runtimePlan.ok
      && resolved.unknownPackIds.length === 0
      && resolved.missingRequiredPackIds.length === 0
      && blockedPackIds.length === 0,
    packIds: resolved.requestedPackIds,
    requestedPackIds: resolved.requestedPackIds,
    resolvedPackIds: resolved.resolvedPacks.map((pack) => pack.id),
    unknownPackIds: resolved.unknownPackIds,
    missingRequiredPackIds: resolved.missingRequiredPackIds,
    blockedPackIds,
    dependencyIds: selectedIds,
    inheritedPermissions: resolved.resolvedPacks.flatMap((pack) => (
      pack.permissions.map((permission) => ({
        packId: pack.id,
        packName: pack.name,
        ...permission,
      }))
    )),
    packGovernance: resolved.resolvedPacks.map((pack) => ({
      id: pack.id,
      name: pack.name,
      version: pack.version,
      installMode: pack.installMode,
      requiredPackIds: [...pack.requiredPackIds],
      security: { ...pack.security },
      governance: {
        ...pack.governance,
        reasons: [...pack.governance.reasons],
      },
    })),
    runtimePlan,
  };
}
