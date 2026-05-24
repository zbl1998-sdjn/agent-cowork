import { createWorkspaceIndex } from './store.js';

export function createWorkspaceRetriever({ root, index } = {}) {
  const workspaceIndex = index || createWorkspaceIndex({ root });

  return {
    index: workspaceIndex,
    root: workspaceIndex.root,

    upsert(input) {
      return workspaceIndex.upsert(input);
    },

    remove(filePath) {
      return workspaceIndex.remove(filePath);
    },

    search(query, options = {}) {
      return workspaceIndex.search({ ...options, query });
    },
  };
}

