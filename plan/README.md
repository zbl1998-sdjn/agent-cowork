# Agent Cowork v1.0 计划总览(导航 + 决策记录)

基线 = **v0.1.0**(`releases/v0.1.0/`)；当前可试版本 = **v0.2.0**(`releases/v0.2.0/`)。北极星:**一个你敢每天用、能干复杂活、能发给别人用、不被单一模型锁死的本地办公智能体。**

## 文档导航(每份小而专)
| 文档 | 作用 | 何时看 |
| --- | --- | --- |
| `00-架构基线与模块依赖.md` | 三单元边界、host 分层依赖规则、上帝类清单与拆分目标、依赖看护 | 动任何代码前必读 |
| `01-工程规则与代码标准.md` | 文件体积/单一职责/可扩展/健壮/安全/测试 + "完成清单(DoD)" | 每个任务收尾对照 |
| `02-v1.0-任务拆解.md` | 细颗粒任务(P0–P4 + FE 前端专项),含 P0-T0 重构前安全网 | 取任务、排期 |
| `03-智能输入与体验进化.md` | 智能输入、澄清优先、记忆画像、活页与进阶前端体验 | 体验增强任务 |
| `04-质量保障与交付安全.md` | CI、E2E、bench、release、安装冒烟、安全隐私基线 | 每次交付前 |
| `05-深水区能力与高级体验.md` | RAG、Office、技能固化、数据分析、开发者模式、分支/项目/通知等深水能力 | v1.0 扩展能力池 |
| `Agent-Cowork-v1.0-迭代计划-草案.md` | 高层阶段路线(已被 00/01/02 细化) | 看全局 |

## 已锁决策(可随时复议)
| # | 决策 | 理由 | 复议条件 |
| --- | --- | --- | --- |
| D1 跨平台 | v1.0 **只锁 Windows**;macOS/Linux 放 **v1.1** | 跨平台工作量大,先把 Windows 体验做透;小步交付 | 有明确 mac/Linux 用户需求时 |
| D2 代码签名 | 无真证书前维持**自签 + 文档说明**;拿到 OV/EV 即切到 P4-A | 真证书需花钱+主体资质 | 你提供 CA 证书后 |
| D3 多模态 | 先做**读图 + 文档/图表产物**;图像生成(P1-C3)**待定** | 文档/图表价值确定、不依赖额外模型;图像生成需可用模型 | 确定要出图 + 有可用图像模型时 |
| D4 遥测 | v1.0 **不做**(隐私优先、纯本地) | 本地个人工具,默认不外发 | 若未来需要,opt-in+默认关+脱敏 |

## ⏸ 提前留位 · 卡外部依赖(用户暂无法提供,主线不阻塞)
> 用户已确认这两项当前无法亲自搞定,**提前在计划里留好位置**:不进 v1.0 关键路径,具备条件后再单独排期。
| 项 | 当前做法(v1.0) | 卡在什么 | 解锁后接 |
| --- | --- | --- | --- |
| RAG 嵌入式进阶版 | **关键词版已完成上线**(零依赖、测试全绿);v1.0 就用它 | 嵌入模型 / 向量库等外部能力 | `05` A1d(接口可插拔,只换实现) |
| 真 CA 代码签名 | 维持**自签 + 文档**(决策 D2) | OV/EV 证书(花钱 + 主体资质) | `02` P4-A |

## 节奏与里程碑
- **小步多次交付**:每完成 1~2 个特性任务出一个小版本给你试。
- **提交节奏**:从当前检查点之后恢复**一特性一提交**;不得再把多个计划线混成一个大提交。
- **v0.2.0** = 全部 P0(地基/拆分,行为不变、全绿)+ FE-1(智能滚动快赢)。
- 每个任务遵循 `01` 的 DoD;每个里程碑打 tag + 出离线快照(git bundle)+ 归档安装包到 `releases/<ver>/`。

## 当前执行顺序
P0-T0 安全网 → P0-T1 看护脚本 → P0-T3 拆 api.ts → P0-T2 拆 server.js → P0-T5 拆 agent-runner → P0-T10a host `checkJs`+JSDoc 类型护栏 → FE-1 智能滚动 → v0.2.0 发布 → P2-A 启动探测真隔离 → P2-B 连接器。

## 当前状态快照(2026-05-25)
- [x] v0.2.0 已切版交付:P0 + FE-1 已打 `v0.2.0` tag,并归档 NSIS/MSI、`agent-cowork-src-v0.2.0.bundle`、`VERSION.txt`、`manifest.json` 到 `releases/v0.2.0/`;当前安装包已静默安装到本机并通过安装版 Tauri smoke,证据见 `reports/windows-client-smoke/installed-tauri-smoke-20260524T223355Z.json`。
- [x] `03/04/05` 已纳入 v1.0 总范围,后续按同一完成标准推进,不再视为附加草稿。
- [x] P0-T10a/Q9(本地可测子项):已新增 host opt-in `checkJs` + JSDoc 类型护栏,覆盖 24 个纯/叶子/安全链路模块(新增 file-preview、live artifact spec/viz、OAuth permissions、JSON store、tool registry 等边界),并加入 host Node 内建最小类型声明;已接入 `npm run check`。
- [ ] P0-T10 延后项:完整 Node 类型覆盖、更多 L0/L1 模块纳入仍在推进;逐文件 `.ts` 转换尚未开始,需先明确直接 Node 运行下的导入/打包路径;不改 Node host 语言栈、不重写。
- [x] P1-A1/P1-A2:后端 `todo_snapshot/todo_update` 事件 + 前端执行清单组件已接入;host/UI 单测与 `npm run ci` 通过。
- [x] P1-A3(本地可测闭环):计划模式批准后的写入已触发 `verify_start` 自检轮;新增 `npm run smoke:plan-loop`,覆盖多文件"研究→计划→批准→执行→自检→收尾"并输出 `build/plan-closed-loop-smoke-report.json`。
- [ ] P1-A3 延后项:真实 Kimi/API key 环境下的用户工作区多文件任务端到端留档仍未完成,不得计作真实模型验收。
- [x] 04-Q6(真实 Kimi API smoke 子项):`npm run smoke:kimi-api` 已修复 guest auth 并在真实 `KIMI_API_KEY` 环境下通过 `/api/kimi/plan`;证据见 `reports/kimi-api-smoke/kimi-api-smoke-20260524T221510Z.json`。该项只证明 Kimi API 通路,不替代 P1-A3 多文件端到端验收。
- [x] FE-1:智能滚动代码+单测完成,并新增 `npm run smoke:react-scroll` 真实浏览器验收;覆盖长对话中翻看历史时流式新内容不强行拽回底部,以及"回到底部"按钮出现/点击回底。
- [x] 03-B1a:活页 `live-artifact.js` 已按 spec/render/refresh 拆为独立模块,新增安全特征测试并通过门禁。
- [x] 03-B1b(本地可测子项):活页 data endpoint 支持手动 refresh 工作区 `file-json` 数据源,并支持已连接 filesystem MCP 的 `mcp__fs__read_text` 作为 connector-tool 数据源;未连接 connector 与高风险 MCP 工具会被拒绝,复用 trustedRoot jail/connector allowlist 安全边界。
- [x] 03-B1c(本地可测子项):前端 `LiveArtifactView` 支持活页预览、手动刷新、可选定时刷新、重开活页与打开产物文件;UI 单测通过,并新增 `npm run smoke:react-live-artifact` 真实浏览器验收(渲染活页→修改 `file-json` 数据源→自动刷新拉取新数据→独立活页刷新渲染新数据),证据见 `reports/react-live-artifact/react-live-artifact-2026-05-24T21-51-04-272Z.json`。
- [ ] 03-B1 延后项:安装版/WebView 内嵌 iframe 的视觉深验仍留到 04-R5 深验。
- [x] 03-B2:产物面板已卡片化,支持打开、重命名;后端 `/api/artifacts/rename` 复用 trustedRoot jail 与幂等键,host/UI 单测通过,并新增 `npm run smoke:react-artifacts` 真实浏览器验收(产物列表→重命名→磁盘同步)。
- [x] 05-B1a:对话消息树/分支模型 + 历史消息编辑 fork 已实现;file/PG 存储和迁移已补测试。
- [x] 05-B1b:分支切换控件、分支差异摘要与 hook 同步已实现;新增 `npm run smoke:react-branches` 真实浏览器验收,覆盖主线→分支→回到主线时的时间线与差异摘要更新;证据见 `reports/react-branches/react-branches-2026-05-24T20-48-18-623Z.json`。
- [x] P1-B1(本地可测子项):`/api/subagent/run` 子代理接口已有 run 记录/时间线;本批补独立上下文预算与步数上限,过大计划返回 413 且不会执行任何工具;直接子代理路由继续拒绝高风险/写入型工具,需走 agent 审批流。
- [x] P1-B2(代码+单测完成):新增 `/api/subagent/parallel` 并行子代理路由与主 agent `AgentParallel` 低风险工具,支持并发上限、子 run 汇总、聚合 run 记录和子任务摘要;所有子任务会在执行前统一校验审批风险与上下文预算,超预算或高风险/写入型步骤不会启动任何子代理。`npm run test:host` 已通过(473 tests,472 pass,1 skip);真实三文件夹端到端性能对比留到 P1-B 后续验收。
- [x] P1-B3(代码+单测完成):`AgentParallel` 现在向执行流发出 `child_start/child_end` 子任务生命周期事件;前端执行动态新增子任务分组,按 index/目标/状态/步数展示并行子任务进度。聚焦 host/UI 单测通过,`npm run test:host` 已通过(473 tests,472 pass,1 skip),`npm run test:ui` 已通过(14 files,65 tests);真实三文件夹端到端性能与安装版视觉深验仍留到后续验收。
- [x] 05-A2d(本地可测子项):批量文件操作已有 preview/apply/rollback 路由,回滚备份受 trustedRoot jail 保护并补单测。
- [x] 04-S3:新增 `check:secrets` 离线静态密钥扫描并接入 `npm run check`;聚焦单测与静态门禁通过。
- [x] 04-R5(本机 source-build 窗口级验收):`smoke-windows-client.ps1` 已在真实 Windows GUI 可执行文件上通过,覆盖窗口启动、计划生成、审批、产物写入、文件移动、审计、回滚和开发者模式;证据见 `reports/windows-client-smoke/windows-client-smoke-20260524T203537Z.json` 与 `reports/windows-client-smoke/windows-client-smoke-20260524T203616Z.json`。`node scripts/verify-mvp.mjs --windows-client` 与 `npm run audit:mvp -- --strict` 已通过。
- [x] 04-R5(安装版 Tauri 外壳/sidecar 验收):新增 `npm run smoke:installed-tauri`;2026-05-25 已重新打包、静默安装 v0.2.0 安装包,并对已安装 `agent-cowork-desktop.exe` 通过主窗口、安装目录 sidecar、自启动 `127.0.0.1:3017`、`/health`、guest auth、`/api/auth/me`、`/api/kimi/info` 与退出后 sidecar 清理验证;证据见 `reports/windows-client-smoke/installed-tauri-smoke-20260524T223355Z.json`。
- [x] P2-A 启动探测真隔离:Host 启动探测 Docker/WSL;设置 `KCW_SANDBOX_DOCKER_IMAGE` 且 Docker daemon + 本地镜像可用时默认选择 `vm:docker` 并通过 `--network=none` 执行;否则回退 local 并在 `/api/sandbox/info` 与设置页自检中提示"本地不隔离网络"。新增 gated 集成测试 `sandbox-docker-integration.test.js`;本机用 `KCW_SANDBOX_REAL_DOCKER_IMAGE=postgres:16-alpine` 真实通过 Docker 联网阻断验收。
- [x] P2-B1 验收补齐:连接器 catalog/管理面板/一键连接已存在;新增 `npm run smoke:react-connectors` 真实浏览器验收,覆盖打开连接器面板→一键连接内置 filesystem MCP→`mcp__fs__read_text` 进入工具 registry。
- [x] P2-B2(本地可测子项):新增 GitHub OAuth device-flow 连接器、`/api/connectors/oauth/{status,start,complete,revoke}`、服务端 device-code session 与 Host 凭证仓库;Windows 默认 DPAPI 保护 access token,状态/撤销只返回脱敏摘要;前端连接器面板已支持开始授权、完成授权、撤销授权。`smoke:react-connectors` 用本地 mock GitHub device-flow 覆盖 UI 闭环和凭证不泄漏。
- [x] P2-B3(本地可测子项):连接器支持断开/撤销;断开 filesystem MCP 会关闭 client 并从工具 registry 移除 `mcp__fs__*`;OAuth 连接器支持 allowlist scope 审批、单次 approval receipt、高风险 scope 标记与前端审批控件;`smoke:react-connectors` 已覆盖连接→断开→工具撤销→GitHub OAuth scope 审批→授权→撤销。
- [ ] P2-B2 延后项:真实 GitHub OAuth 账号授权仍需配置外部 OAuth App client id 并人工完成浏览器授权;当前不得计作真实外部 OAuth 验收。
- [ ] 04-R5 延后项:WebView 内部深交互、真实 Kimi 回复、生产代码签名/信任链仍未验收。
- [ ] 需真实环境的延期验收:真实 Kimi 多文件 E2E、Office/OCR、生产代码签名信任链相关验证。

## 状态
- [x] 方向与北极星确定(四线全要,排成 P0→P4 + FE 专项)
- [x] 架构依赖规则(00)、工程标准(01)、细颗粒任务(02)成稿
- [x] 重构前安全网(P0-T0)纳入,先于一切拆分
- [x] 前端优化专项线(FE,聚焦交互修复/架构分层+错误空态/流式性能;设计系统暂缓)
- [x] 4 个开放问题按默认锁成 D1–D4
- [x] 已开工:P0 地基、03/04/05 多个本地可测切片已完成并纳入 CI
- [ ] 继续:深度优先收尾 P2-B OAuth 真实外部验收;P1-A3 真实 Kimi 多文件留档、05-A2 Office 深操作等仍按延期验收清单处理。
