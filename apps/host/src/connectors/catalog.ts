// 连接器目录(host · L1 领域层 · connectors)
// ---------------------------------------------------------------------------
// 职责:精选的 MCP 连接器清单 + 关键词推荐(类比「建议连接器」)。每项含命令/安装模板与可选 OAuth
//       授权信息;builtin:true 表示该能力 host 已内置。
// 依赖:无。导出:连接器目录与按关键词建议的函数。
//
// Connector catalog + keyword suggest (the Claude Cowork "suggest connectors"
// analog). A curated list of MCP connectors with command/install templates;
// builtin:true means the capability already ships in this host.

export type OAuthPermissionDescriptor = {
  id: string;
  label: string;
  description?: string;
  risk?: string;
  default?: boolean;
};

export type ConnectorAuth = {
  type: string;
  provider: string;
  scopes?: string[];
  permissions?: OAuthPermissionDescriptor[];
};

export type ConnectorDescriptor = {
  id: string;
  name: string;
  description: string;
  keywords: string[];
  builtin?: boolean;
  auth?: ConnectorAuth;
  command?: string;
  args?: string[];
  install?: string;
  score?: number;
};

type SuggestConnectorOptions = {
  limit?: number;
};

const CONNECTORS = [
  {
    id: 'filesystem', name: '文件系统', description: '读取/列出本地目录, jail 在指定 root 内',
    keywords: ['file', '文件', '目录', 'folder', 'fs', 'filesystem', 'read', 'list'],
    builtin: true, command: 'node', args: ['scripts/run-host-node.mjs', 'apps/host/mcp-servers/fs-server.ts', '<root>'],
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
    id: 'github', name: 'GitHub', description: '通过 OAuth 授权读取 GitHub 用户资料,后续接 issue/repo 工具',
    keywords: ['github', 'repo', 'issue', 'pull request', 'oauth', '代码仓库'],
    builtin: true,
    auth: {
      type: 'oauth-device',
      provider: 'github',
      scopes: ['read:user'],
      permissions: [
        {
          id: 'read:user',
          label: '读取 GitHub 用户资料',
          description: '读取账号登录名、公开资料和邮箱摘要',
          risk: 'low',
          default: true,
        },
        {
          id: 'repo',
          label: '读取私有仓库',
          description: '允许后续仓库/issue 工具访问私有仓库范围',
          risk: 'high',
          default: false,
        },
      ],
    },
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

function tokenize(text: unknown): string[] {
  return String(text || '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(Boolean);
}

export function listConnectors(): ConnectorDescriptor[] {
  return CONNECTORS.map((c) => ({ ...c }));
}

export function getConnector(id: unknown): ConnectorDescriptor | null {
  const key = String(id || '').toLowerCase();
  return listConnectors().find((connector) => connector.id.toLowerCase() === key) || null;
}

export function suggestConnectors(query: unknown, { limit = 5 }: SuggestConnectorOptions = {}): ConnectorDescriptor[] {
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
