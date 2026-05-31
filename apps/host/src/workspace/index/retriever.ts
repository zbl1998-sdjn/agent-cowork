// 工作区检索器(host · L1 领域层 · workspace/index)
// ---------------------------------------------------------------------------
// 职责:对 store(倒排式内存索引)的薄封装,暴露 upsert/remove/search 三个稳定方法,
//       让上层(search.js)与索引实现解耦、便于将来替换检索后端。
// 依赖:同目录 store。导出:createWorkspaceRetriever。
import { createWorkspaceIndex } from './store.js';

type WorkspaceIndex = ReturnType<typeof createWorkspaceIndex>;
type UpsertInput = Parameters<WorkspaceIndex['upsert']>[0];
type SearchInput = Exclude<NonNullable<Parameters<WorkspaceIndex['search']>[0]>, string>;
type SearchOptions = Omit<SearchInput, 'query'>;

/** 创建工作区检索器(可注入已有 index,否则按 root 新建);返回 { index, root, upsert, remove, search }。 */
export function createWorkspaceRetriever({ root, index }: { root?: unknown; index?: WorkspaceIndex } = {}) {
  const workspaceIndex = index || createWorkspaceIndex({ root });

  return {
    index: workspaceIndex,
    root: workspaceIndex.root,

    upsert(input: UpsertInput) {
      return workspaceIndex.upsert(input);
    },

    remove(filePath: string) {
      return workspaceIndex.remove(filePath);
    },

    search(query: unknown, options: SearchOptions = {}) {
      return workspaceIndex.search({ ...options, query });
    },
  };
}
