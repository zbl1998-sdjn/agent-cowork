// Project workspace store (05-B4).
//
// Organizes conversations and artifacts into projects. Pure in-memory core with
// a clean interface; a persistence adapter (file/sqlite/pg) can wrap it later,
// mirroring the conversation/memory store pattern. Layer L1 (storage), no
// upward imports, fully testable. A conversation/artifact belongs to at most
// one project; removing a project clears its memberships.

export function createProjectStore({ now = () => Date.now() } = {}) {
  const projects = new Map();
  const conversationProject = new Map();
  const artifactProject = new Map();
  let seq = 0;

  const snapshot = (project) => ({ ...project });

  function requireProject(id) {
    const project = projects.get(id);
    if (!project) {
      throw new Error(`unknown project: ${id}`);
    }
    return project;
  }

  function cleanName(name) {
    const clean = String(name == null ? '' : name).trim();
    if (!clean) {
      throw new Error('project name is required');
    }
    return clean.slice(0, 120);
  }

  return {
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

    rename(id, name) {
      const project = requireProject(id);
      project.name = cleanName(name);
      project.updatedAt = now();
      return snapshot(project);
    },

    setColor(id, color) {
      const project = requireProject(id);
      project.color = color ?? null;
      project.updatedAt = now();
      return snapshot(project);
    },

    archive(id) {
      const project = requireProject(id);
      project.archived = true;
      project.updatedAt = now();
      return snapshot(project);
    },

    unarchive(id) {
      const project = requireProject(id);
      project.archived = false;
      project.updatedAt = now();
      return snapshot(project);
    },

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

    get(id) {
      const project = projects.get(id);
      return project ? snapshot(project) : null;
    },

    list({ includeArchived = true } = {}) {
      const all = [...projects.values()].map(snapshot);
      return includeArchived ? all : all.filter((project) => !project.archived);
    },

    assignConversation(projectId, conversationId) {
      requireProject(projectId);
      if (!conversationId) {
        throw new Error('conversationId is required');
      }
      conversationProject.set(String(conversationId), projectId);
    },

    unassignConversation(conversationId) {
      return conversationProject.delete(String(conversationId));
    },

    projectOfConversation(conversationId) {
      return conversationProject.get(String(conversationId)) ?? null;
    },

    conversationsOf(projectId) {
      const out = [];
      for (const [conversationId, pid] of conversationProject) {
        if (pid === projectId) out.push(conversationId);
      }
      return out;
    },

    assignArtifact(projectId, artifactId) {
      requireProject(projectId);
      if (!artifactId) {
        throw new Error('artifactId is required');
      }
      artifactProject.set(String(artifactId), projectId);
    },

    unassignArtifact(artifactId) {
      return artifactProject.delete(String(artifactId));
    },

    artifactsOf(projectId) {
      const out = [];
      for (const [artifactId, pid] of artifactProject) {
        if (pid === projectId) out.push(artifactId);
      }
      return out;
    },

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
