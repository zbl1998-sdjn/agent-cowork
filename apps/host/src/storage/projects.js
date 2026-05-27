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

/** @param {ProjectStoreOptions} [options] @returns {ProjectStore} */
export function createProjectStore({ now = () => Date.now() } = {}) {
  /** @type {Map<string, ProjectRecord>} */
  const projects = new Map();
  /** @type {Map<string, string>} */
  const conversationProject = new Map();
  /** @type {Map<string, string>} */
  const artifactProject = new Map();
  let seq = 0;

  /** @param {ProjectRecord} project @returns {ProjectRecord} */
  const snapshot = (project) => ({ ...project });

  /** @param {string} id @returns {ProjectRecord} */
  function requireProject(id) {
    const project = projects.get(id);
    if (!project) {
      throw new Error(`unknown project: ${id}`);
    }
    return project;
  }

  /** @param {unknown} name @returns {string} */
  function cleanName(name) {
    const clean = String(name == null ? '' : name).trim();
    if (!clean) {
      throw new Error('project name is required');
    }
    return clean.slice(0, 120);
  }

  return {
    /** @param {CreateProjectInput} [input] @returns {ProjectRecord} */
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

    /** @param {string} id @param {unknown} name @returns {ProjectRecord} */
    rename(id, name) {
      const project = requireProject(id);
      project.name = cleanName(name);
      project.updatedAt = now();
      return snapshot(project);
    },

    /** @param {string} id @param {unknown} color @returns {ProjectRecord} */
    setColor(id, color) {
      const project = requireProject(id);
      project.color = color ?? null;
      project.updatedAt = now();
      return snapshot(project);
    },

    /** @param {string} id @returns {ProjectRecord} */
    archive(id) {
      const project = requireProject(id);
      project.archived = true;
      project.updatedAt = now();
      return snapshot(project);
    },

    /** @param {string} id @returns {ProjectRecord} */
    unarchive(id) {
      const project = requireProject(id);
      project.archived = false;
      project.updatedAt = now();
      return snapshot(project);
    },

    /** @param {string} id @returns {boolean} */
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

    /** @param {string} id @returns {ProjectRecord | null} */
    get(id) {
      const project = projects.get(id);
      return project ? snapshot(project) : null;
    },

    /** @param {ListProjectOptions} [options] @returns {ProjectRecord[]} */
    list({ includeArchived = true } = {}) {
      const all = [...projects.values()].map(snapshot);
      return includeArchived ? all : all.filter((project) => !project.archived);
    },

    /** @param {string} projectId @param {unknown} conversationId @returns {void} */
    assignConversation(projectId, conversationId) {
      requireProject(projectId);
      if (!conversationId) {
        throw new Error('conversationId is required');
      }
      conversationProject.set(String(conversationId), projectId);
    },

    /** @param {unknown} conversationId @returns {boolean} */
    unassignConversation(conversationId) {
      return conversationProject.delete(String(conversationId));
    },

    /** @param {unknown} conversationId @returns {string | null} */
    projectOfConversation(conversationId) {
      return conversationProject.get(String(conversationId)) ?? null;
    },

    /** @param {string} projectId @returns {string[]} */
    conversationsOf(projectId) {
      /** @type {string[]} */
      const out = [];
      for (const [conversationId, pid] of conversationProject) {
        if (pid === projectId) out.push(conversationId);
      }
      return out;
    },

    /** @param {string} projectId @param {unknown} artifactId @returns {void} */
    assignArtifact(projectId, artifactId) {
      requireProject(projectId);
      if (!artifactId) {
        throw new Error('artifactId is required');
      }
      artifactProject.set(String(artifactId), projectId);
    },

    /** @param {unknown} artifactId @returns {boolean} */
    unassignArtifact(artifactId) {
      return artifactProject.delete(String(artifactId));
    },

    /** @param {string} projectId @returns {string[]} */
    artifactsOf(projectId) {
      /** @type {string[]} */
      const out = [];
      for (const [artifactId, pid] of artifactProject) {
        if (pid === projectId) out.push(artifactId);
      }
      return out;
    },

    /** @param {string} id @returns {{ conversations: number, artifacts: number }} */
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
