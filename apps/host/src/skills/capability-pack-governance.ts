// Capability pack 治理(host · L1 skills 域)
// ---------------------------------------------------------------------------
// 职责:校验静态能力包清单并给出 fail-closed 治理结论。这里只审计元数据，
//       不下载、不安装、不启用、也不执行能力包代码。

export type CapabilityPackCategory = 'capability' | 'role' | 'connector' | 'model' | 'design';

export type CapabilityPackManifest = {
  schemaVersion: 'agent-cowork.pack.v1';
  id: string;
  name: string;
  version: string;
  description: string;
  category: CapabilityPackCategory;
  publisher: string;
  license: string;
  capabilities: string[];
  dependencyIds: string[];
  requiredPackIds: string[];
  recommendedForRoles: string[];
  permissions: Array<{
    kind: string;
    scope: string;
    reason: string;
    default: 'deny' | 'ask' | 'allow';
  }>;
  installMode: 'bundled' | 'plan-only';
  security: {
    signed: boolean;
    sandboxRequired: boolean;
    networkDuringRuntime: 'none' | 'ask' | 'required';
  };
};

export type CapabilityPackGovernance = {
  status: 'bundled_trusted' | 'review_required' | 'blocked';
  executable: boolean;
  reviewRequired: boolean;
  reasons: string[];
};

export type GovernedCapabilityPack = CapabilityPackManifest & {
  governance: CapabilityPackGovernance;
};

export type CapabilityPackAuditOptions = {
  knownDependencyIds?: ReadonlySet<string>;
};

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function duplicateIds(packs: readonly CapabilityPackManifest[]): Set<string> {
  const counts = new Map<string, number>();
  for (const pack of packs) counts.set(pack.id, (counts.get(pack.id) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count > 1).map(([id]) => id));
}

function cyclicIds(packs: readonly CapabilityPackManifest[], duplicates: ReadonlySet<string>): Set<string> {
  const byId = new Map(
    packs.filter((pack) => !duplicates.has(pack.id)).map((pack) => [pack.id, pack]),
  );
  const state = new Map<string, 'visiting' | 'visited'>();
  const cycles = new Set<string>();
  for (const rootId of byId.keys()) {
    if (state.has(rootId)) continue;
    const stack = [{ id: rootId, nextRequiredIndex: 0 }];
    state.set(rootId, 'visiting');
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (!frame) throw new Error('capability pack audit stack invariant violated');
      const requiredIds = byId.get(frame.id)?.requiredPackIds ?? [];
      if (frame.nextRequiredIndex >= requiredIds.length) {
        state.set(frame.id, 'visited');
        stack.pop();
        continue;
      }
      const requiredId = requiredIds[frame.nextRequiredIndex];
      frame.nextRequiredIndex += 1;
      if (!requiredId || !byId.has(requiredId)) continue;
      const requiredState = state.get(requiredId);
      if (requiredState === 'visiting') {
        const cycleStart = stack.findIndex((candidate) => candidate.id === requiredId);
        for (const member of stack.slice(Math.max(0, cycleStart))) cycles.add(member.id);
      } else if (requiredState !== 'visited') {
        state.set(requiredId, 'visiting');
        stack.push({ id: requiredId, nextRequiredIndex: 0 });
      }
    }
  }
  return cycles;
}

function blockingReasons(
  pack: CapabilityPackManifest,
  knownIds: ReadonlySet<string>,
  duplicates: ReadonlySet<string>,
  cycles: ReadonlySet<string>,
  knownDependencyIds?: ReadonlySet<string>,
): string[] {
  const reasons: string[] = [];
  if (pack.schemaVersion !== 'agent-cowork.pack.v1') reasons.push('unsupported_schema');
  if (!pack.id.trim() || !pack.name.trim() || pack.capabilities.length === 0) reasons.push('invalid_identity');
  if (!SEMVER.test(pack.version)) reasons.push('invalid_version');
  if (duplicates.has(pack.id)) reasons.push('duplicate_pack_id');
  if (cycles.has(pack.id)) reasons.push('required_pack_cycle');
  for (const requiredId of pack.requiredPackIds) {
    if (!knownIds.has(requiredId)) reasons.push(`required_pack_missing:${requiredId}`);
  }
  if (knownDependencyIds) {
    for (const dependencyId of pack.dependencyIds) {
      if (!knownDependencyIds.has(dependencyId)) {
        reasons.push(`runtime_dependency_missing:${dependencyId}`);
      }
    }
  }
  if (pack.permissions.some((permission) => permission.default === 'allow')) {
    reasons.push('permission_default_allow');
  }
  if (pack.installMode === 'bundled') {
    if (!pack.security.signed) reasons.push('bundled_signature_missing');
    if (pack.publisher !== 'Agent Cowork' || pack.license !== 'internal') {
      reasons.push('bundled_publisher_untrusted');
    }
  }
  return [...new Set(reasons)];
}

export function auditCapabilityPacks(
  packs: readonly CapabilityPackManifest[],
  options: CapabilityPackAuditOptions = {},
): GovernedCapabilityPack[] {
  const duplicates = duplicateIds(packs);
  const cycles = cyclicIds(packs, duplicates);
  const knownIds = new Set(packs.map((pack) => pack.id));
  const uniqueIndexById = new Map<string, number>();
  packs.forEach((pack, index) => {
    if (!duplicates.has(pack.id)) uniqueIndexById.set(pack.id, index);
  });
  const reasonsByPack = packs.map((pack) => (
    blockingReasons(pack, knownIds, duplicates, cycles, options.knownDependencyIds)
  ));

  // Governance is transitive: an executable pack cannot hide a blocked or
  // non-executable required pack behind an otherwise valid manifest.
  let changed = true;
  while (changed) {
    changed = false;
    packs.forEach((pack, index) => {
      const reasons = reasonsByPack[index];
      if (!reasons) return;
      for (const requiredId of pack.requiredPackIds) {
        const requiredIndex = uniqueIndexById.get(requiredId);
        const required = requiredIndex === undefined ? undefined : packs[requiredIndex];
        const requiredReasons = requiredIndex === undefined ? undefined : reasonsByPack[requiredIndex];
        const reason = requiredIndex === undefined && knownIds.has(requiredId)
          ? `required_pack_blocked:${requiredId}`
          : requiredReasons && requiredReasons.length > 0
            ? `required_pack_blocked:${requiredId}`
            : required !== undefined
                && pack.installMode === 'bundled'
                && required.installMode !== 'bundled'
              ? `required_pack_not_executable:${requiredId}`
              : null;
        if (reason && !reasons.includes(reason)) {
          reasons.push(reason);
          changed = true;
        }
      }
    });
  }

  return packs.map((pack, index) => {
    const reasons = [...(reasonsByPack[index] ?? [])];
    const status = reasons.length > 0
      ? 'blocked'
      : pack.installMode === 'bundled'
        ? 'bundled_trusted'
        : 'review_required';
    if (status === 'review_required') reasons.push('plan_only');
    return {
      ...pack,
      capabilities: [...pack.capabilities],
      dependencyIds: [...pack.dependencyIds],
      requiredPackIds: [...pack.requiredPackIds],
      recommendedForRoles: [...pack.recommendedForRoles],
      permissions: pack.permissions.map((permission) => ({ ...permission })),
      security: { ...pack.security },
      governance: {
        status,
        executable: status === 'bundled_trusted',
        reviewRequired: status === 'review_required',
        reasons,
      },
    };
  });
}
