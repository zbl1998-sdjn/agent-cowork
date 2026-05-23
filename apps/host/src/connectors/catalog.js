// Connector catalog + keyword suggest (the Claude Cowork "suggest connectors"
// analog). A curated list of MCP connectors with command/install templates;
// builtin:true means the capability already ships in this host.

const CONNECTORS = [
  {
    id: 'filesystem', name: '文件系统', description: '读取/列出本地目录, jail 在指定 root 内',
    keywords: ['file', '文件', '目录', 'folder', 'fs', 'filesystem', 'read', 'list'],
    builtin: true, command: 'node', args: ['apps/host/mcp-servers/fs-server.mjs', '<root>'],
  },
  {
    id: 'web-fetch', name: 'Web 抓取', description: '抓取网页内容做联网研究 (内置 web.fetch 工具)',
    keywords: ['web', 'http', '网页', 'fetch', 'url', 'research', '联网', '搜索'],
    builtin: true,
  },
  {
    id: 'memory', name: '长期记忆', description: '工作区长期事实与笔记 (内置 Memory)',
    keywords: ['memory', '记忆', 'notes', 'facts', '笔记'],
    builtin: true,
  },
  {
    id: 'sqlite', name: 'SQLite', description: '查询本地 SQLite 数据库',
    keywords: ['sqlite', 'db', '数据库', 'sql', 'query', '查询'],
    install: 'npx -y @modelcontextprotocol/server-sqlite <db-path>',
  },
  {
    id: 'git', name: 'Git', description: '本地 Git 仓库历史/状态/diff',
    keywords: ['git', 'commit', '仓库', 'repo', 'version', '版本', 'diff'],
    install: 'npx -y @modelcontextprotocol/server-git --repository <repo-path>',
  },
  {
    id: 'postgres', name: 'PostgreSQL', description: '只读查询 Postgres 数据库',
    keywords: ['postgres', 'postgresql', 'pg', '数据库', 'sql'],
    install: 'npx -y @modelcontextprotocol/server-postgres <connection-string>',
  },
];

function tokenize(text) {
  return String(text || '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean);
}

export function listConnectors() {
  return CONNECTORS.map((c) => ({ ...c }));
}

export function suggestConnectors(query, { limit = 5 } = {}) {
  const terms = tokenize(query);
  const all = listConnectors();
  if (terms.length === 0) {
    return all.slice(0, limit);
  }
  return all
    .map((c) => {
      const hay = `${c.id} ${c.name} ${c.description} ${(c.keywords || []).join(' ')}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if ((c.keywords || []).some((k) => k.toLowerCase() === term)) score += 3;
        else if (hay.includes(term)) score += 1;
      }
      return { connector: c, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => ({ ...row.connector, score: row.score }));
}
