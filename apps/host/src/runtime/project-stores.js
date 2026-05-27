import { createProjectStore } from '../storage/projects.js';

// @ts-check

/**
 * @typedef {{ tenantId?: string, userId?: string }} ProjectStoreContext
 * @typedef {{ projectStores?: Map<string, unknown>, getProjectStore?: (trustedRoot: string, context?: ProjectStoreContext) => unknown }} ProjectStoreConfig
 */

/** @param {ProjectStoreConfig} config */
export function createProjectStoreResolver(config = {}) {
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
