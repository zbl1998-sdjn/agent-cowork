// 项目存储装配(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:按租户/用户上下文装配并复用「项目存储」实例的运行时薄封装,屏蔽底层 storage/projects 细节。
// 依赖:storage/projects。导出:项目存储装配函数。
import path from 'node:path';
import { identityScopeTupleKey, requireIdentityScopeFrom } from '../security/identity-scope.js';
import { createProjectStore } from '../storage/projects.js';

export type ProjectStoreContext = { tenantId?: string; userId?: string };
export type ProjectStore = ReturnType<typeof createProjectStore>;
export type ProjectStoreResolver = {
  projectStores: Map<string, ProjectStore>;
  getProjectStore(trustedRoot: string, context?: ProjectStoreContext): ProjectStore;
};
export type ProjectStoreConfig = {
  projectStores?: Map<string, ProjectStore>;
  getProjectStore?: (trustedRoot: string, context?: ProjectStoreContext) => ProjectStore;
};

export function createProjectStoreResolver(config: ProjectStoreConfig = {}): ProjectStoreResolver {
  const projectStores = config.projectStores || new Map();
  const getProjectStore = config.getProjectStore || ((trustedRoot, context) => {
    const owner = requireIdentityScopeFrom(context, {
      allowLocalDefault: true,
      label: 'project store identity',
    });
    const canonicalRoot = path.resolve(trustedRoot);
    const key = identityScopeTupleKey(owner, canonicalRoot);
    const existing = projectStores.get(key);
    if (existing) return existing;
    const created = createProjectStore();
    projectStores.set(key, created);
    return created;
  });
  return { projectStores, getProjectStore };
}
