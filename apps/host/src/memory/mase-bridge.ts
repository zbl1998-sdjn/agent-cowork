// MASE 记忆桥接(host · L1 领域层 · memory)
// ---------------------------------------------------------------------------
// 职责:把 host 启动时已接入的 mase-memory MCP 工具(见 main.ts 的 MCP-on-start)桥接成
//       agent cowork 的「自动记忆后端」:每轮对话开始用 mase_recall 召回相关历史事实、
//       作为会话记忆层注入上下文;每轮结束用 mase_remember 把「用户输入+助手回答」写回 MASE。
//       仅在 mase-memory 工具已注册(MASE_MCP_ENABLED=1 且连接成功)时生效,否则全程 no-op。
// 依赖:仅一个最小 ToolCaller 形状(has/call),不直接持有/创建 MCP 连接。导出:两个桥接函数。

// 只依赖工具注册表的 has/call 形状,避免与 ToolRegistry 实现强耦合。
type ToolCaller = {
  has?(name: string): boolean;
  call(name: string, args?: unknown, ctx?: Record<string, unknown>): Promise<unknown> | unknown;
};

const RECALL_TOOL = 'mcp__mase-memory__mase_recall';
const REMEMBER_TOOL = 'mcp__mase-memory__mase_remember';
const UPSERT_FACT_TOOL = 'mcp__mase-memory__mase_upsert_fact';
const GET_FACTS_TOOL = 'mcp__mase-memory__mase_get_facts';
const REMEMBER_MAX_CHARS = 4000;
const FACT_CATEGORY = 'conversation_facts';
// 召回硬超时:MASE 慢/卡也只让本轮"不带记忆"地走,绝不让对话干等(避免 demo 卡 60s)。
const RECALL_TIMEOUT_MS = 2500;

// MCP tools/call 结果形如 { content: [{ type: 'text', text: string }], isError }。
function mcpTextItems(result: unknown): string[] {
  const content = (result as { content?: unknown } | null | undefined)?.content;
  if (!Array.isArray(content)) return [];
  return content
    .map((item) => (item && typeof item === 'object' ? (item as { text?: unknown }).text : null))
    .filter((text): text is string => typeof text === 'string' && text.length > 0);
}

// MASE 的 mase_recall 按空格切词,无空格中文整句会变成一个无法命中的巨型词。
// 这里把查询切成「ASCII 词 + CJK 重叠 bigram」并以空格连接,让中文整句也能命中 FTS。
function segmentForRecall(query: string): string {
  const tokens: string[] = [];
  const pattern = /[A-Za-z0-9_]+|[一-鿿]+/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(query)) !== null) {
    const token = match[0];
    if (/^[A-Za-z0-9_]/.test(token)) {
      tokens.push(token);
    } else if (token.length <= 2) {
      tokens.push(token);
    } else {
      for (let i = 0; i < token.length - 1; i += 1) tokens.push(token.slice(i, i + 2));
    }
  }
  return tokens.join(' ');
}

function toolAvailable(registry: ToolCaller | null | undefined, tool: string): registry is ToolCaller {
  if (!registry || typeof registry.call !== 'function') return false;
  return typeof registry.has === 'function' ? registry.has(tool) : true;
}

// 解析 mase_get_facts 返回的当前事实列表(content[].text 里是 JSON 数组或单条对象)。
function parseCurrentFacts(result: unknown): Array<{ key: string; value: string }> {
  const facts: Array<{ key: string; value: string }> = [];
  const collect = (obj: unknown): void => {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
    const row = obj as Record<string, unknown>;
    const key = row.entity_key ?? row.key;
    const value = row.entity_value ?? row.value;
    if (typeof key === 'string' && key && value !== undefined && value !== null) {
      facts.push({ key, value: String(value) });
    }
  };
  for (const text of mcpTextItems(result)) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) parsed.forEach(collect);
      else collect(parsed);
    } catch {
      // 非 JSON 文本忽略。
    }
  }
  return facts;
}

// 读缝:拼出注入 loadLayeredMemory 的 sessionMemory 文本——
//   ①【当前事实】无条件全量注入 entity_state(不依赖 query 措辞,保证当前状态始终在场);
//   ②【相关历史】再按本轮输入做关键词召回补充。
// 真·fail-safe:整段召回有 RECALL_TIMEOUT_MS 短超时——MASE 慢/卡也只降级到"本轮不带记忆",
// 绝不让对话干等;出错/无内容同样返空串(慢也降级,不只是错才降级)。
export async function maseRecallSessionMemory(
  registry: ToolCaller | null | undefined,
  query: string,
  topK = 5,
): Promise<string> {
  return Promise.race([
    recallSessionMemoryInner(registry, query, topK),
    new Promise<string>((resolve) => { setTimeout(() => resolve(''), RECALL_TIMEOUT_MS); }),
  ]);
}

async function recallSessionMemoryInner(
  registry: ToolCaller | null | undefined,
  query: string,
  topK = 5,
): Promise<string> {
  const blocks: string[] = [];

  // ① 当前结构化事实(全部,高优先级,不依赖 query)。
  if (toolAvailable(registry, GET_FACTS_TOOL)) {
    try {
      const facts = parseCurrentFacts(await registry.call(GET_FACTS_TOOL, {}));
      if (facts.length) {
        blocks.push([
          '【当前事实】(用户陈述的当前状态,回答涉及这些信息时以此为准):',
          ...facts.map((fact) => `- ${fact.key}: ${fact.value}`),
        ].join('\n'));
      }
    } catch {
      // 取当前事实失败不影响后续召回。
    }
  }

  // ② 按本轮输入召回相关历史(facts-first BM25)。
  const trimmedQuery = String(query || '').trim();
  if (trimmedQuery && toolAvailable(registry, RECALL_TOOL)) {
    try {
      const result = await registry.call(RECALL_TOOL, { query: segmentForRecall(trimmedQuery) || trimmedQuery, top_k: topK });
      const hits: string[] = [];
      for (const text of mcpTextItems(result)) {
        let hit = text;
        try {
          const parsed = JSON.parse(text) as { content?: unknown };
          if (parsed && typeof parsed.content === 'string') hit = parsed.content;
        } catch {
          // 非 JSON 文本原样保留。
        }
        const normalized = hit.trim();
        if (normalized) hits.push(normalized);
      }
      if (hits.length) {
        blocks.push(['【相关历史】(供参考,不要据此编造未提及的信息):', ...hits.map((hit) => `- ${hit}`)].join('\n'));
      }
    } catch {
      // 召回失败不影响已取到的当前事实。
    }
  }

  return blocks.join('\n\n');
}

// 启发式抽取用户这轮话里的显式事实("X 是/为/=/改成 Y"),跳过疑问/任务句。
// 故意保守:只抓明确陈述,宁缺毋滥(抽错会污染 entity_state)。category/key/value 三元组。
export type MaseFact = { category: string; key: string; value: string };
export function extractFactsFromUser(userText: string): MaseFact[] {
  const facts: MaseFact[] = [];
  const seen = new Set<string>();
  // 精度门控:只在"明确记忆意图"下抽取——整轮有记忆提示词(记住/更正…),否则只接受"我/我的/你的"自述子句。
  const turnHasCue = /记住|记一下|记下|记录|更正|纠正|记一笔/.test(String(userText || ''));
  for (const segment of String(userText || '').split(/[。;；\n]+/)) {
    let clause = segment.trim();
    if (!clause) continue;
    // 跳过疑问句 / 任务句(避免把提问当事实)。
    if (/[?？]|什么|哪个|哪些|多少|是否|吗|呢|如何|怎么|为什么|区别|解释|推荐|等于/.test(clause)) continue;
    // 剥掉开头的"<提示词…>:"(如"请记住一个事实:"、"更正一下:")。
    clause = clause.replace(/^.{0,15}?(?:记住|记一下|记下|记录|更正|纠正|注意|提醒|告诉你|说一下)[^：:]{0,6}[：:]\s*/, '');
    // 剥掉开头连接词("还有""另外""顺便"…),让"我的…"自述结构露出来。
    clause = clause.replace(/^(?:还有|另外|顺便(?:记一下)?|再(?:说一下)?|而且|然后|对了)[:：、,，]?\s*/, '');
    // 无记忆提示、且非"我/我的/你的"自述的子句一律不抽(过滤闲聊/任务句:"今天天气是晴天""把文件名改成X")。
    if (!turnHasCue && !/^(?:我的|我|你的)/.test(clause)) continue;
    const matched = clause.match(/^(.+?)\s*(?:改成|改为|更新为|设置为|设为|叫做|是|为|=|＝|叫)\s*(\S.{0,48}?)\s*$/);
    const rawKey = matched?.[1];
    const rawValue = matched?.[2];
    if (!rawKey || !rawValue) continue;
    const key = rawKey
      .replace(/^(?:请|牢牢|麻烦|帮我|一定|务必|再|还有|另外|顺便|更正|纠正|记住|一个|这是|此为|事实|信息|[，,：:、的\s])+/g, '')
      .replace(/^(?:我的|我|你的|本次的?|本项目的?|这个项目的?|这个的?|当前的?)\s*/, '')
      .trim();
    const value = rawValue.trim().replace(/[。.．,，;；!！、]+$/, '');
    // 纯数字几乎总是 value 而非 key(如"301是房间号"是反着说),跳过纯数字 key。
    if (key.length < 2 || key.length > 14 || /^\d+$/.test(key) || !value || value.length > 50) continue;
    const dedup = `${key}=${value}`;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    facts.push({ category: FACT_CATEGORY, key, value });
    if (facts.length >= 5) break;
  }
  return facts;
}

// 从 mase_remember 返回里解析出 log_id(返回文本含 "Event logged with ID N")。
function parseLogId(remembered: unknown): number | undefined {
  for (const text of mcpTextItems(remembered)) {
    const matched = text.match(/ID\s+(\d+)/);
    if (matched) return Number(matched[1]);
  }
  return undefined;
}

// 写缝:把一轮对话写回 MASE——
//   ① 用户、助手各写一条 role 正确的事件日志(mase_remember);
//   ② 从用户话抽出的结构化事实 upsert 进 entity_state(mase_upsert_fact),并带上
//      source_log_id(指向触发它的用户那条 log)+ reason 做"事实 ⇄ 对话"溯源;同 key 改值自动 supersede。
// 各步 fail-safe,任一失败不阻断聊天;工具未注册(MASE 关闭)则整体 no-op。
export async function maseRememberTurn(
  registry: ToolCaller | null | undefined,
  userText: string,
  assistantText: string,
  threadId?: string,
): Promise<void> {
  const user = String(userText || '').trim();
  const assistant = String(assistantText || '').trim();
  if (!user && !assistant) return;
  const thread = threadId || 'agent-cowork';

  // ① 用户/助手各一条 log(role 各自正确),记下用户那条的 log_id 供事实溯源。
  let userLogId: number | undefined;
  if (toolAvailable(registry, REMEMBER_TOOL)) {
    if (user) {
      try {
        userLogId = parseLogId(await registry.call(REMEMBER_TOOL, { text: user.slice(0, REMEMBER_MAX_CHARS), thread_id: thread, role: 'user' }));
      } catch {
        // 用户 log 写入失败不影响后续。
      }
    }
    if (assistant) {
      try {
        await registry.call(REMEMBER_TOOL, { text: assistant.slice(0, REMEMBER_MAX_CHARS), thread_id: thread, role: 'assistant' });
      } catch {
        // 助手 log 写入失败不影响后续。
      }
    }
  }

  // ② 结构化事实 → entity_state,带 source_log_id + reason 溯源。
  if (user && toolAvailable(registry, UPSERT_FACT_TOOL)) {
    const reason = /更正|纠正|改成|改为|不对|说错|应该是/.test(user) ? 'agent-cowork:用户更正' : 'agent-cowork:用户陈述';
    for (const fact of extractFactsFromUser(user)) {
      try {
        await registry.call(UPSERT_FACT_TOOL, {
          category: fact.category,
          key: fact.key,
          value: fact.value,
          reason,
          source_log_id: userLogId ?? 0,
        });
      } catch {
        // 单条事实 upsert 失败不影响其它事实与对话返回。
      }
    }
  }
}
