// 项目存储装配(host · L2 运行时 · runtime)
// ---------------------------------------------------------------------------
// 职责:按租户/用户上下文装配并复用「项目存储」实例的运行时薄封装,屏蔽底层 storage/projects 细节。
// 依赖:storage/projects。导出:项目存储装配函数。
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
  const getProjectStore = config.getProjectStore || ((trustedRoot, context = {}) => {
    const tenantId = context.tenantId || 'tenant_local';
    const userId = context.userId || 'user_local';
    const key = `${tenantId}\0${userId}\0${trustedRoot}`;
    if (!projectStores.has(key)) {
      projectStores.set(key, createProjectStore());
    }
    return projectStores.get(key);
  });
  return { projectStores, getProjectStore };
}
