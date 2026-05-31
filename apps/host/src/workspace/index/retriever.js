// 工作区检索器(host · L1 领域层 · workspace/index)
// ---------------------------------------------------------------------------
// 职责:对 store(倒排式内存索引)的薄封装,暴露 upsert/remove/search 三个稳定方法,
//       让上层(search.js)与索引实现解耦、便于将来替换检索后端。
// 依赖:同目录 store。导出:createWorkspaceRetriever。
import { createWorkspaceIndex } from './store.js';

/**
 * @typedef {import('./store.js').WorkspaceIndex} WorkspaceIndex
 * @typedef {import('./store.js').UpsertInput} UpsertInput
 * @typedef {import('./store.js').SearchInput} SearchInput
 */

/** 创建工作区检索器(可注入已有 index,否则按 root 新建);返回 { index, root, upsert, remove, search }。 @param {{ root?: unknown, index?: WorkspaceIndex }} [options] */
export function createWorkspaceRetriever({ root, index } = {}) {
  const workspaceIndex = index || createWorkspaceIndex({ root });

  return {
    index: workspaceIndex,
    root: workspaceIndex.root,

    /** @param {UpsertInput} input */
    upsert(input) {
      return workspaceIndex.upsert(input);
    },

    /** @param {string} filePath */
    remove(filePath) {
      return workspaceIndex.remove(filePath);
    },

    /** @param {unknown} query @param {Omit<SearchInput, 'query'>} [options] */
    search(query, options = {}) {
      return workspaceIndex.search({ ...options, query });
    },
  };
}
