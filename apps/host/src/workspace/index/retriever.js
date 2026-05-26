import { createWorkspaceIndex } from './store.js';

/**
 * @typedef {import('./store.js').WorkspaceIndex} WorkspaceIndex
 * @typedef {import('./store.js').UpsertInput} UpsertInput
 * @typedef {import('./store.js').SearchInput} SearchInput
 */

/** @param {{ root?: unknown, index?: WorkspaceIndex }} [options] */
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
