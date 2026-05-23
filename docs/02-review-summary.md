# Agent Cowork — 全面 Review 小结

> 一次性盘点当前实现、测试健康度、架构与代码健康、风险/技术债与建议。日期基准:本轮迭代结束。

## 1. 能力清单(对齐 Claude Cowork)

**Agent 内核**:OpenAI 兼容真 token 流式;工具调用循环(Read/Write/Edit/Glob/Grep/Shell/WebFetch + `mcp__` 连接器);风险分级审批(高风险才拦);计划模式(ExitPlanMode 先审批后执行);AskUserQuestion 中途多选提问;多轮自我验证(写后只读自检);工具懒加载(search_tools 按需激活);取消/中断(步间 + 客户端断连即清理)+ token 用量;五层 memory + skills 注入;hooks(opt-in);subagents;**多模态视觉**(上传图片以 image_url 喂模型);**自然语言定时任务**(ScheduleTask 工具)。

**前端(对话页)**:左侧多会话历史栏(新建/切换/重命名/删除/搜索/置顶,localStorage 持久化、刷新不丢、导出 Markdown);助手散文式渲染 + 富 Markdown;消息淡入/运行脉冲;**富工具调用卡片**(可折叠看参数/结果);计划卡、提问卡、审批条、停止/用量条;后续动作建议 chips + 空态启动卡;内联图表(chart/mermaid);产物一键打开 + 产物面板;连接器面板(一键连 MCP);定时任务面板。

**平台/数据层**:幂等键、ULID、租户/用户/trace 打标;请求体限额 + CORS/Origin;审计 EventBus;**JWT(HS256)无状态鉴权**;每租户并发上限(429);**优雅停机**(drain SSE + cancelAll);**全量 PostgreSQL 数据层**(runs-index/memory/schedules/approvals/run-events,经 `KCW_STORE=postgres`),含跨实例 LISTEN/NOTIFY 审批与 SSE pub/sub。

## 2. 测试健康度

- **后端**:66 个 `node --test` 测试文件,约 290+ 用例;本轮全量分批跑 **0 失败**。覆盖单元(注册表/幂等/路径策略/usage/JWT)、集成(HTTP 路由 + SSE 帧契约)、并发(40 路断连无泄漏)、PG 适配器(mock pool)、跨实例(共享 mock 集群)、断连清理、优雅停机、实测基准(150/500 并发 0 错误零泄漏)。
- **前端**:`tsc -b` 严格通过 + `vite build` 成功(JS≈181KB)。无自动化测试运行器(下述风险)。
- **MCP spawn 类测试**(connectors/mcp-connect/fs-server/connector-connect):单跑通过,批量跑在本沙箱 VM 易超时(环境问题,非代码)。

## 3. 架构与代码健康

- **Ports & Adapters** 贯彻良好:存储层 file/sqlite/postgres 三套适配器同接口;读路径 `await` 化后对同步/异步适配器透明。
- **零依赖原则**:host 默认零依赖;`pg` 为惰性可选依赖,仅 `KCW_STORE=postgres` 时加载。
- **一致的安全边界**:所有文件操作 `assertTrustedPath` jail;审批集中在 ActionPolicy(risk==='high' || mutating)。
- **补丁纪律**:本轮所有改动用「node 字符串替换 + 命中断言 + 即时 node --check/tsc」,规避了环境里后台 linter 偶发截断文件的问题。

## 4. 风险 / 技术债

1. **前端单测**:✅ 已引入 vitest——`md.ts`(extractSuggestions/splitVizBlocks/renderMarkdown)与抽出的 `lib/conversations.ts`(convTitle/conversationToMarkdown/isImagePath)共 13 项通过(`npm test`)。组件级(会话同步 effect、工具卡状态机)仍可补 React Testing Library。
2. **真实基础设施未联调**:PG 适配器/跨实例机制均为 mock-pool 验证;**需在真实 Postgres 集群 + 多实例 + 负载均衡上端到端联调与 10 万级压测**(代码/迁移/契约已就绪)。
3. **CachedPostgresScheduleStore 多实例**:同步门面 + 写穿透适合单实例 PG 持久化;多实例下定时触发需分布式锁(避免重复触发),目前未做。
4. **会话持久化在客户端**:多会话存 localStorage(单机、容量上限 50×60)。多设备/团队共享需后端会话表(可复用 runs-index/tenant 模型)。
5. **memory 注入 vs memoryStore**:agent 提示注入走 file 版 `loadLayeredMemory`;PG `memoryStore` 仅服务 `/api/memory` 路由。若要分层记忆也走 PG,需统一注入路径。
6. **环境噪声**:本沙箱有后台进程偶发截断文件(已规避并修复);与产品代码无关,但提示 CI 应加 `node --check` 全量门禁。

## 5. 建议(后续)

- 引入前端单测(vitest)+ 关键 e2e 纳入 CI;CI 加全量 `node --check` 门禁。
- 在真实环境按 `docs/01` 第 8 节联通 PostgreSQL,跑 `scripts/load-sse.mjs` 多实例阶梯压测。
- schedules 多实例分布式锁;会话后端持久化;memory 注入统一到 PG。
- 真实 SaaS 连接器(OAuth:Slack/Notion/Gmail)——价值高,需 OAuth 基建。
