// 项目工作区存储(纯内存核心)(host · L1 领域层 · storage)
// ---------------------------------------------------------------------------
// 职责:把对话与制品归入项目——增删改查项目、归档/取消归档、维护对话↔项目与制品↔项目
//       的归属(各自至多属一个项目),删项目时清掉其成员关系并给出计数统计。
// 依赖:仅标准库。后端:纯内存(将来可由文件/sqlite/pg 持久化适配包装)。
// 导出:createProjectStore(工厂,返回实现 ProjectStore 接口的对象)。
//
// Project workspace store (05-B4).
//
// Organizes conversations and artifacts into projects. Pure in-memory core with
// a clean interface; a persistence adapter (file/sqlite/pg) can wrap it later,
// mirroring the conversation/memory store pattern. Layer L1 (storage), no
// upward imports, fully testable. A conversation/artifact belongs to at most
// one project; removing a project clears its memberships.
// @ts-check

/**
 * @typedef {{ id: string, name: string, color: unknown | null, archived: boolean, createdAt: number, updatedAt: number }} ProjectRecord
 * @typedef {{ name?: unknown, color?: unknown }} CreateProjectInput
 * @typedef {{ includeArchived?: boolean }} ListProjectOptions
 * @typedef {{ now?: () => number }} ProjectStoreOptions
 * @typedef {{ create(input?: CreateProjectInput): ProjectRecord, rename(id: string, name: unknown): ProjectRecord, setColor(id: string, color: unknown): ProjectRecord, archive(id: string): ProjectRecord, unarchive(id: string): ProjectRecord, remove(id: string): boolean, get(id: string): ProjectRecord | null, list(options?: ListProjectOptions): ProjectRecord[], assignConversation(projectId: string, conversationId: unknown): void, unassignConversation(conversationId: unknown): boolean, projectOfConversation(conversationId: unknown): string | null, conversationsOf(projectId: string): string[], assignArtifact(projectId: string, artifactId: unknown): void, unassignArtifact(artifactId: unknown): boolean, artifactsOf(projectId: string): string[], stats(id: string): { conversations: number, artifacts: number } }} ProjectStore
 */

/** 工厂:创建内存项目存储,闭包持有项目表与对话/制品的归属映射。 @param {ProjectStoreOptions} [options] @returns {ProjectStore} */
export function createProjectStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, ProjectRecord>} */
  const projects = new Map();
  /** @type {Map<string, string>} */
  const conversationProject = new Map();
  /** @type {Map<string, string>} */
  const artifactProject = new Map();
  let seq = 0;

  /** 返回项目记录的浅拷贝快照,避免外部改到内部状态。 @param {ProjectRecord} project @returns {ProjectRecord} */
  const snapshot = (project) => ({ ...project });

  /** 取项目,不存在则抛错(供改写类方法前置校验)。 @param {string} id @returns {ProjectRecord} */
  function requireProject(id) {
    const project = projects.get(id);
    if (!project) {
      throw new Error(`unknown project: ${id}`);
    }
    return project;
  }

  /** 校验并规整项目名:去空白、非空、截断到 120 字符。 @param {unknown} name @returns {string} */
  function cleanName(name) {
    const clean = String(name == null ? '' : name).trim();
    if (!clean) {
      throw new Error('project name is required');
    }
    return clean.slice(0, 120);
  }

  return {
    /** 新建项目(自增 id),返回快照。 @param {CreateProjectInput} [input] @returns {ProjectRecord} */
    create({ name, color = null } = {}) {
      seq += 1;
      const ts = now();
      const project = {
        id: `proj_${seq}`,
        name: cleanName(name),
        color: color ?? null,
        archived: false,
        createdAt: ts,
        updatedAt: ts,
      };
      projects.set(project.id, project);
      return snapshot(project);
    },

    /** 重命名项目并刷新 updatedAt。 @param {string} id @param {unknown} name @returns {ProjectRecord} */
    rename(id, name) {
      const project = requireProject(id);
      project.name = cleanName(name);
      project.updatedAt = now();
      return snapshot(project);
    },

    /** 设置项目颜色并刷新 updatedAt。 @param {string} id @param {unknown} color @returns {ProjectRecord} */
    setColor(id, color) {
      const project = requireProject(id);
      project.color = color ?? null;
      project.updatedAt = now();
      return snapshot(project);
    },

    /** 归档项目(置 archived=true)。 @param {string} id @returns {ProjectRecord} */
    archive(id) {
      const project = requireProject(id);
      project.archived = true;
      project.updatedAt = now();
      return snapshot(project);
    },

    /** 取消归档(置 archived=false)。 @param {string} id @returns {ProjectRecord} */
    unarchive(id) {
      const project = requireProject(id);
      project.archived = false;
      project.updatedAt = now();
      return snapshot(project);
    },

    /** 删除项目并清掉其名下所有对话/制品归属;返回是否存在过。 @param {string} id @returns {boolean} */
    remove(id) {
      if (!projects.has(id)) {
        return false;
      }
      projects.delete(id);
      for (const [conversationId, projectId] of conversationProject) {
        if (projectId === id) conversationProject.delete(conversationId);
      }
      for (const [artifactId, projectId] of artifactProject) {
        if (projectId === id) artifactProject.delete(artifactId);
      }
      return true;
    },

    /** 取项目快照,不存在返回 null。 @param {string} id @returns {ProjectRecord | null} */
    get(id) {
      const project = projects.get(id);
      return project ? snapshot(project) : null;
    },

    /** 列出项目快照,默认含已归档。 @param {ListProjectOptions} [options] @returns {ProjectRecord[]} */
    list({ includeArchived = true } = {}) {
      const all = [...projects.values()].map(snapshot);
      return includeArchived ? all : all.filter((project) => !project.archived);
    },

    /** 把对话归到项目(覆盖原归属)。 @param {string} projectId @param {unknown} conversationId @returns {void} */
    assignConversation(projectId, conversationId) {
      requireProject(projectId);
      if (!conversationId) {
        throw new Error('conversationId is required');
      }
      conversationProject.set(String(conversationId), projectId);
    },

    /** 解除对话归属,返回是否原本有归属。 @param {unknown} conversationId @returns {boolean} */
    unassignConversation(conversationId) {
      return conversationProject.delete(String(conversationId));
    },

    /** 查对话所属项目 id,无则返回 null。 @param {unknown} conversationId @returns {string | null} */
    projectOfConversation(conversationId) {
      return conversationProject.get(String(conversationId)) ?? null;
    },

    /** 列出归属某项目的全部对话 id。 @param {string} projectId @returns {string[]} */
    conversationsOf(projectId) {
      /** @type {string[]} */
      const out = [];
      for (const [conversationId, pid] of conversationProject) {
        if (pid === projectId) out.push(conversationId);
      }
      return out;
    },

    /** 把制品归到项目(覆盖原归属)。 @param {string} projectId @param {unknown} artifactId @returns {void} */
    assignArtifact(projectId, artifactId) {
      requireProject(projectId);
      if (!artifactId) {
        throw new Error('artifactId is required');
      }
      artifactProject.set(String(artifactId), projectId);
    },

    /** 解除制品归属,返回是否原本有归属。 @param {unknown} artifactId @returns {boolean} */
    unassignArtifact(artifactId) {
      return artifactProject.delete(String(artifactId));
    },

    /** 列出归属某项目的全部制品 id。 @param {string} projectId @returns {string[]} */
    artifactsOf(projectId) {
      /** @type {string[]} */
      const out = [];
      for (const [artifactId, pid] of artifactProject) {
        if (pid === projectId) out.push(artifactId);
      }
      return out;
    },

    /** 统计某项目下的对话数与制品数。 @param {string} id @returns {{ conversations: number, artifacts: number }} */
    stats(id) {
      requireProject(id);
      let conversations = 0;
      for (const pid of conversationProject.values()) {
        if (pid === id) conversations += 1;
      }
      let artifacts = 0;
      for (const pid of artifactProject.values()) {
        if (pid === id) artifacts += 1;
      }
      return { conversations, artifacts };
    },
  };
}
