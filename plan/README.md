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
| `06-运行时依赖与集成安装.md` | 开箱即用依赖、安装器组件、按需下载、中文 Windows 生命周期细节 | 安装/发布/依赖任务 |
| `07-Agent运行时韧性与评测体系.md` | eval、上下文管理、循环韧性、可恢复/可复现、可观测、预算熔断和回路安全 | Agent 运行时加固任务 |
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
- [x] `03/04/05/06/07` 已纳入 v1.0 总范围,后续按同一完成标准推进,不再视为附加草稿。
- [x] P0-T10a/Q9(本地可测子项):已新增 host opt-in `checkJs` + JSDoc 类型护栏,覆盖 49 个纯/叶子/安全链路模块(新增 file-preview、live artifact spec/viz、OAuth GitHub/device flow、OAuth permission receipt、OAuth permissions、JSON store、tool registry、Office writer、run-store、agent-resume 等边界),并加入 host Node 内建最小类型声明;已接入 `npm run check`。
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
- [x] 03-B4/06-F6 首启引导基础闭环:新增 onboarding 推荐路由与首启面板,按角色推荐技能/连接器/设置项,展示依赖体检推荐组件与当前状态摘要,支持本地降级推荐、进入设置和完成/稍后再说;host/UI 单测通过,本机 5173 UI + 3017 host smoke 覆盖 guest 登录后首启面板展示。
- [x] 05-B1a:对话消息树/分支模型 + 历史消息编辑 fork 已实现;file/PG 存储和迁移已补测试。
- [x] 05-B1b:分支切换控件、分支差异摘要与 hook 同步已实现;新增 `npm run smoke:react-branches` 真实浏览器验收,覆盖主线→分支→回到主线时的时间线与差异摘要更新;证据见 `reports/react-branches/react-branches-2026-05-24T20-48-18-623Z.json`。
- [x] P1-B1(本地可测子项):`/api/subagent/run` 子代理接口已有 run 记录/时间线;本批补独立上下文预算与步数上限,过大计划返回 413 且不会执行任何工具;直接子代理路由继续拒绝高风险/写入型工具,需走 agent 审批流。
- [x] P1-B2(代码+单测完成):新增 `/api/subagent/parallel` 并行子代理路由与主 agent `AgentParallel` 低风险工具,支持并发上限、子 run 汇总、聚合 run 记录和子任务摘要;所有子任务会在执行前统一校验审批风险与上下文预算,超预算或高风险/写入型步骤不会启动任何子代理。`npm run test:host` 已通过(473 tests,472 pass,1 skip);真实三文件夹端到端性能对比留到 P1-B 后续验收。
- [x] P1-B3(代码+单测完成):`AgentParallel` 现在向执行流发出 `child_start/child_end` 子任务生命周期事件;前端执行动态新增子任务分组,按 index/目标/状态/步数展示并行子任务进度。聚焦 host/UI 单测通过,`npm run test:host` 已通过(473 tests,472 pass,1 skip),`npm run test:ui` 已通过(14 files,65 tests);真实三文件夹端到端性能与安装版视觉深验仍留到后续验收。
- [x] P1-C1(代码+单测完成):`summary-report` recipe 现在会同时生成 Markdown、DOCX、PPTX、PDF 产物;DOCX/PPTX/PDF writer 全部本地实现并纳入 host `checkJs`,产物 catalog 会把 `.docx/.pptx/.xlsx/.pdf` 显式标成 Word/演示/表格/PDF。`npm run test:host` 已通过(478 tests,477 pass,1 skip),`npm run check` 已通过;真实 Office 打开、OCR 与安装版深交互仍留到延期验收。
- [x] P1-D1(代码+单测完成):新增 approval exact-ID 批量 resolve 能力:in-memory registry、Postgres approval store 与 `/api/approvals/batch` 均支持显式 id 列表批量审批,逐个保留 tenant/user scope 校验和 decision 归一化;不支持 wildcard/runId/all,不做同类工具通配自动批准。前端时间线在多个待审批 id 同时可见时显示"批准当前 N 个"入口。新增 host/UI 单测覆盖非法 id、跨租户拒绝、PG 跨实例、异步 store 路由、API helper 和批量入口渲染。
- [x] P1-D2(代码+单测完成):工具调用卡片现在展示状态、耗时、失败原因,并保留可展开参数/结果;host `tool_result` 事件补充 `durationMs`,前端也有本地耗时兜底。新增 host/UI 单测覆盖执行耗时事件与卡片可读失败信息。
- [x] P1-D3(代码+单测完成):`cancelled` SSE 不再被前端当作 `done`,停止运行会落到 `cancelled` 状态并显示可继续收尾文案;失败/取消回答补"继续"入口,状态徽标补齐"已取消"。新增 UI 单测覆盖取消帧路由、继续入口和取消态徽标;后端断点续跑 HTTP 接线与真实长任务视觉验收留到后续。
- [x] 05-A2d(本地可测子项):批量文件操作已有 preview/apply/rollback 路由,回滚备份受 trustedRoot jail 保护并补单测。
- [x] 04-S3:新增 `check:secrets` 离线静态密钥扫描并接入 `npm run check`;聚焦单测与静态门禁通过。
- [x] 04-R5(本机 source-build 窗口级验收):`smoke-windows-client.ps1` 已在真实 Windows GUI 可执行文件上通过,覆盖窗口启动、计划生成、审批、产物写入、文件移动、审计、回滚和开发者模式;证据见 `reports/windows-client-smoke/windows-client-smoke-20260524T203537Z.json` 与 `reports/windows-client-smoke/windows-client-smoke-20260524T203616Z.json`。`node scripts/verify-mvp.mjs --windows-client` 与 `npm run audit:mvp -- --strict` 已通过。
- [x] 04-R5(安装版 Tauri 外壳/sidecar 验收):新增 `npm run smoke:installed-tauri`;2026-05-25 已重新打包、静默安装 v0.2.0 安装包,并对已安装 `agent-cowork-desktop.exe` 通过主窗口、安装目录 sidecar、自启动 `127.0.0.1:3017`、`/health`、guest auth、`/api/auth/me`、`/api/kimi/info` 与退出后 sidecar 清理验证;证据见 `reports/windows-client-smoke/installed-tauri-smoke-20260524T223355Z.json`。
- [x] P2-A 启动探测真隔离:Host 启动探测 Docker/WSL;设置 `KCW_SANDBOX_DOCKER_IMAGE` 且 Docker daemon + 本地镜像可用时默认选择 `vm:docker` 并通过 `--network=none` 执行;否则回退 local 并在 `/api/sandbox/info` 与设置页自检中提示"本地不隔离网络"。新增 gated 集成测试 `sandbox-docker-integration.test.js`;本机用 `KCW_SANDBOX_REAL_DOCKER_IMAGE=postgres:16-alpine` 真实通过 Docker 联网阻断验收。
- [x] 06-A1 WebView2 安装器引导:Tauri Windows bundle 显式配置 `webviewInstallMode.type=embedBootstrapper`,安装包会内置 WebView2 Evergreen bootstrapper,在缺失 WebView2 的 Windows 机器上由安装器补齐运行时;scaffold 单测与安装版 smoke dry-run 均校验该配置。
- [x] 06-A2 内嵌 Python 运行器接入(代码+单测完成):`runCode` 在本地 sandbox 后端检测 `KCW_EMBEDDED_PYTHON`/`KCW_PYTHON_HOME` 后优先通过内嵌解释器目录运行 `python/python3`,同时先校验原始请求工具在 sandbox allowlist 内,避免配置绕过;VM/docker 后端继续使用容器内裸 `python/python3`。新增单测覆盖本地优先、VM 不改写、allowlist 不放宽。
- [x] 06-A3 CJK 字体包预检:运行时依赖状态识别 `KCW_CJK_FONT_DIR`/`KCW_CJK_FONT`,目录或文件中存在 `.ttf/.otf/.ttc/.woff2` 字体文件才标记可用;缺失时提示安装器补齐字体包。新增 host 单测覆盖字体目录可用与缺失路径拒绝;真实字体资产打包仍留给安装器阶段。
- [x] 06-A4 Node 运行器接入(代码+单测完成):`runCode` 在本地 sandbox 后端对 `node` 优先使用 `KCW_NODE_EXE`/`KCW_NODE_HOME` 或开发态 host `process.execPath` 所在目录,通过 PATH 前缀命中自带 Node;VM/docker 后端继续使用镜像内 `node`。新增单测覆盖本地优先、VM 不改写、allowlist 不放宽和相对配置忽略。
- [x] 06-A5 VC++ 运行库预检:运行时依赖状态优先识别安装器配置标记,Windows 下只读查询 VC Runtime x64/x86 注册表 `Installed` 标记并展示版本,缺失时提示安装器补齐;非 Windows 标记为不适用。新增 host 单测覆盖配置优先、x64/x86 可用、缺失与非 Windows 不探测。
- [x] 06-D 依赖管理器基础面板:设置页新增"运行时"tab,读取 `/api/runtime/dependencies` 展示核心/可选/按需组件状态、中文用途说明、检测详情、安装方式、体积估算和核心异常警示;host 新增安装/清理/更新计划 API(`/install-plan`、`/cleanup-plan`、`/update-plan`),只生成可审查计划、不执行下载或删除,真实安装/下载仍留给后续按需组件流程。UI 纯逻辑/API 与 host 路由/auth-gate 测试通过。
- [x] 06-D2 安装计划预检 UI:运行时依赖面板可从缺失/待补的按需组件生成 `/api/runtime/dependencies/install-plan` 预检,展示预计下载、磁盘空间状态、组件列表和未知组件,刷新依赖时清空旧预检;仅展示可审查计划,不执行真实安装或下载。UI 测试(32 files,137 tests)、UI build 与 `npm run check` 通过。
- [x] 06-F1 中文路径/长路径 smoke:新增 `npm run smoke:windows-paths`,在中文 workspace 与 >260 字符路径下覆盖文件树、读取、预览、搜索、context bundle、上传导入、artifact 列表/查看/改名、批量写/改名/移动/回滚;同时断言越界路径、敏感路径与 junction 逃逸不会写出 trustedRoot。
- [x] 06-F2 SQLite 原生绑定/运行时 smoke:新增 `npm run smoke:sqlite-runtime`,强制 host 使用 `storeBackend=sqlite` 写入鉴权、记忆、recipe run 与 schedule 并重启读回;安装版 `smoke:installed-tauri` 以 `KCW_STORE=sqlite` 启动真实 sidecar,断言 `/api/runtime/dependencies` 中 SQLite 可用、写链路生成 `state.sqlite`,并在安装版重启后验证 auth/memory/run/schedule 仍可读。真实安装版验收已暴露并修复 SEA 内 migration 文件不可见问题,证据见 `reports/windows-client-smoke/installed-tauri-smoke-20260525T162931Z.json`。
- [x] 06-F3 卸载/清理计划基础闭环:依赖 catalog 为按需组件声明 AppData 下组件目录,新增 `buildRuntimeDependencyCleanupPlan`,区分"保留用户数据"与"删除用户数据"两种模式;清理目标只允许落在 `%APPDATA%\AgentCowork` 组件/cache 目录内,删除本机用户数据必须二次确认。纯函数单测覆盖保留、删除与非法根路径拒绝;真实 installer 卸载 UI/执行仍留给后续安装器接线。
- [x] 06-F3b 清理计划预检 UI:运行时依赖面板可向 `/api/runtime/dependencies/cleanup-plan` 生成"保留用户数据/删除用户数据"两种预案,展示 AppData 根、将清理/保留目标、未知组件、警告和二次确认提示;仅展示可审查计划,不执行真实删除。UI/API/view-model 单测、UI build 与 `npm run check` 通过。
- [x] 06-F3c 卸载器清理执行接线:Tauri NSIS 配置接入 `installerHooks`,在用户勾选卸载器"删除应用数据"且非更新模式时清理 `%APPDATA%\AgentCowork`;安装版 smoke 会校验 hook 配置、路径不逃逸、删除动作受确认和 update gate 保护。新增 host 单测锁定 hook 文件与安全根。
- [x] 06-F4 按用户安装(免管理员):Windows 打包面收敛为 NSIS setup 并在 `tauri.conf.json` 显式 `installMode=currentUser`;`build2.ps1`/签名脚本不再要求 MSI。安装版 smoke dry-run/真机链路断言已安装程序位于 `%LOCALAPPDATA%\Agent Cowork`,HKCU 存在卸载项且 HKLM 不存在全机卸载项,覆盖默认免管理员安装边界;证据见 `reports/windows-client-smoke/installed-tauri-smoke-20260525T174940Z.json`。
- [x] 06-F5 更新保留组件/数据:新增 `buildRuntimeDependencyUpdatePlan`,把升级策略固定为只替换安装目录应用本体、保留 `%APPDATA%\AgentCowork` 下用户数据、`venv`、按需组件和下载缓存;新增 `npm run smoke:runtime-update` 用真实 AppData sentinel 文件验证 update plan 无删除动作且路径不逃逸,证据见 `reports/runtime-dependencies/runtime-update-preservation-2026-05-25T18-03-30-683Z.json`。
- [x] 06-B5 ffmpeg plan-only 支持:运行时依赖 catalog 纳入按需安装的便携版 ffmpeg,进入依赖面板、安装计划预检、清理计划和更新保留计划;仅做可审查计划,不执行真实下载或删除。host/UI 单测锁定 B5 分组、体积估算和 `%APPDATA%\AgentCowork\components\ffmpeg` 安全根。
- [x] 06-B6 MinGit plan-only 支持:运行时依赖状态优先识别 `KCW_MINGIT_HOME`/`KCW_GIT_HOME`,否则用短超时 `git --version` 探测系统 Git;缺失时保持按需安装计划,并纳入安装预检、清理计划和更新保留计划。新增 host 单测覆盖配置优先、系统 Git 可用、缺失状态与 `%APPDATA%\AgentCowork\components\mingit` 安全根。
- [x] 06-B1 数据分析组件 plan-only 支持:运行时依赖状态识别 `KCW_DATA_SCIENCE_HOME`/`KCW_DATA_SCIENCE_VENV`,目录内包含 pandas/numpy/matplotlib package marker 才标记可用;缺失或不完整时保持按需安装计划。新增 host 单测覆盖完整组件可用与缺包拒绝,不执行下载、建 venv 或 pip install。
- [x] 06-B2 Chromium 组件 plan-only 支持:运行时依赖状态识别 `KCW_PLAYWRIGHT_CHROMIUM_HOME`/`KCW_CHROMIUM_EXECUTABLE`,目录中存在 `chrome/chromium(.exe)` marker 才标记浏览器自动化组件可用;缺失或名称不匹配时保持按需安装计划。新增 host 单测覆盖 Playwright home 可用与错误可执行文件拒绝,不执行浏览器、下载或 Playwright install。
- [x] 06-B3 OCR 组件 plan-only 支持:运行时依赖状态识别 `KCW_TESSERACT_HOME`/`KCW_TESSDATA_PREFIX`,存在 `chi_sim.traineddata` 或 `chi_tra.traineddata` 才标记中文 OCR 可用;缺失时保持按需安装计划。新增 host 单测覆盖中文语言包可用与缺包拒绝,不执行下载、OCR 调用或系统安装。
- [x] 06-B4 Pandoc 组件 plan-only 支持:运行时依赖状态识别 `KCW_PANDOC_HOME`/`KCW_PANDOC_EXE`,目录中存在 `pandoc(.exe)` 或 `bin/pandoc(.exe)` 才标记可用;缺失或名称不匹配时保持按需安装计划。新增 host 单测覆盖目录可用与错误可执行文件拒绝,不执行 pandoc 或下载。
- [x] 06-F8 磁盘空间预检:运行时依赖 catalog 已为按需组件记录体积估算,新增 `dependency-install-plan` 纯函数生成安装/下载计划;当可用磁盘空间不足时返回中文阻断提示,用于后续依赖面板/安装器复用。聚焦 `runtime-dependencies.test.js` 通过,`npm run check` 通过。
- [x] 06-F9 离线可用性:新增 `npm run smoke:offline-local`,在清空 Kimi/proxy 环境并拦截非本机 fetch 的情况下验证 health/workspace/文件读取/文件写入/依赖状态/audit 仍可用;模型路由无 key 时返回中文说明"本地文件功能仍可离线使用,模型回复需联网配置 key",证据见 `reports/offline-local/offline-local-smoke-2026-05-25T18-09-33-602Z.json`。
- [x] 07-A 评测体系(A1-A7):已新增 EvalTask schema、21 个 golden 任务、7 个 redteam 任务、多维 scorer、隔离 trustedRoot runner、JSON/HTML 报告、离线 replay backend 与 CI eval 回归门禁;`npm run eval` 当前 28/28 通过,`npm run test:host` 当前 496 tests,495 pass,1 skip。eval 产物写入 `reports/eval/` 并作为本地产物忽略。
- [x] 07-B1 TokenEstimator:新增 `kimi/context/token-estimator.js` 启发式估算器,支持 text/messages、message overhead、reply primer、tool call/object content 计数与 host `checkJs`;`npm run test:host` 当前 499 tests,498 pass,1 skip。
- [x] 07-B2 HistoryCompactor:新增 `kimi/context/history-compactor.js` 纯压缩器,超预算时压缩旧历史、保留最近消息、提取关键事实清单,并覆盖 ≥200 轮历史不溢出窗口与关键事实不丢的行为测试。
- [x] 07-B3 ToolResultSummarizer:新增 `kimi/context/tool-result-summarizer.js` 纯摘要器,大工具结果按 token 预算压缩成关键要点+来源+预览,替代后续 `tool-loop` 硬截断接入前的可插拔能力;覆盖小结果原样、大结构化结果要点/source 不丢、超长文本 source-like 行保留的行为测试。
- [x] 07-B4 ContextManager 接入 tool-loop:新增 `kimi/context/context-manager.js`,组合 token 估算、历史压缩与工具结果摘要;`tool-loop` 每轮模型调用前压缩消息、工具结果回灌前按 token 预算摘要,并补热点特征测试锁定大工具结果不再硬截断且保留关键要点/source。
- [x] 07-C1 LoopGuard:新增 `kimi/agent/loop-guard.js` 纯循环护栏,按工具名+稳定参数指纹检测重复调用和连续失败,达到阈值返回可读打断原因;覆盖参数顺序稳定、不同工具/参数隔离、成功重置连续失败。
- [x] 07-C2 RetryPolicy:新增 `kimi/agent/tool-retry.js` 纯重试策略,仅对网络/超时/文件锁/临时繁忙等可重试错误做有界指数退避,权限/参数/schema/path 越界等永久失败立即上报;覆盖 thrown error 与 `{ error }` 工具结果两种失败形态。
- [x] 07-C3 tool-loop 韧性接入:`tool-loop` 已消费 LoopGuard + RetryPolicy;可重试工具失败先重试再回灌模型,重复相同工具调用达到阈值发出 `loop_guard_break` 并停止当前路径,不再跑满 maxSteps。
- [x] 07-F1 BudgetGuard:新增 `runtime/budget-guard.js`,支持 per-run/per-session token、估算成本和 wall-clock 硬上限;agent stream 入口创建预算守卫并注入 `tool-loop`,模型 usage 超限或运行超时会发出 `budget_guard_abort`、停止后续工具执行并直接返回可读收尾文案。
- [x] 07-F2 整轮 wall-clock 超时:新增 `kimi/agent/run-timeout.js`,整轮运行 signal 会传入模型调用;挂起模型调用达到 `runTimeoutMs` 后触发 `run_timeout` 并安全收尾,不依赖 maxSteps 或单模型默认 timeout。
- [x] 07-F3 流式中断恢复:OpenAI-compatible SSE parser 在模型流中途断开时保留已累计 content/reasoning/usage 与完整 tool_calls,返回 `stream_interrupted` 元数据;不完整工具参数只进 `partial_tool_calls`,不会被下游当成可执行工具调用。
- [x] 07-D1 Checkpointer:新增 `runtime/run-checkpoint.js` 与 agent checkpoint 注入器;SSE agent 运行会在模型工具调用、工具结果、验证请求、完成和预算/超时/循环停止边界写入 `runStoreRoot/checkpoints/<runId>.json`,完整保存 messages/step/usage/approvedTools/todos/metadata 并可读回。
- [x] 07-D2 run-resume:新增 `runtime/run-resume.js`,可从最新检查点生成 `resumeState`;`tool-loop` 支持从检查点消息、usage、已批准工具和 todo 续跑。已用崩溃后续跑测试锁定已完成工具 handler 不重复执行、文件副作用不重复。
- [x] 07-D2b HTTP/SSE 续跑入口:`/api/agent/chat/stream` 支持 `resumeRunId`,从 checkpoint 读回 `resumeState` 后沿用原 runId 继续 SSE;缺 checkpoint 返回 404。E2E 覆盖写入后崩溃再续跑,确认不会重放已完成写操作。
- [x] 07-D3 ModelRecorder/Replayer 状态闭环:`runtime/model-recorder.js` 已支持脱敏 model-call 录制、JSONL 持久化与确定性回放,`eval/replay-backend.js` 默认复用该回放后端;replay miss fail-closed,失败记录不参与回放,API key/token/callback/signal 不落盘。聚焦 `model-recorder.test.js`、`eval-replay-backend.test.js` 与 `npm run eval` 验证通过。
- [x] 07-D4 seed 注入:新增 L0 `util/ids.js` seedable ID 源;`createRunId`/`createUlid` 支持注入随机源,agent stream 支持 `runSeed` 生成可复现 start `runId`,便于 replay/debug 对齐轨迹。
- [x] 07-E1 RunMetrics:新增 `runtime/run-metrics.js`,所有 `writeRunRecord` 持久化记录都会自动带 `metrics`(token/估算成本/耗时/步骤/工具调用/失败率);agent stream 记录已持久化聚合 usage。`npm run test:host` 当前 536 tests,535 pass,1 skip。
- [x] 07-E2 前端成本/可观测面板:新增 `ObservabilityPanel` 与 `/api/runs` typed helpers,展示 token、成本、工具为什么、耗时、模型/配置归因和来源跳转。UI 测试通过(25 files,114 tests),本机 5173 UI + 3017 host 烟测可打开面板。
- [x] 07-E3 版本归因:新增 `runtime/run-attribution.js`,所有 `writeRunRecord` 持久化记录都会自动带 `attribution`(输入 prompt 哈希、system-prompt 版本、prompt builder、provider/model/mode/baseUrl 与脱敏配置快照);agent stream 记录只写入安全配置摘要。`npm run test:host` 当前 539 tests,538 pass,1 skip。
- [x] 07-E4 决策 trace:新增 `runtime/run-trace.js`/`run-trace-normalizers.js`,可结构化记录模型上下文、工具决策、why、工具结果并通过 `run-events` 回放;也可从现有 messages 构建决策轨迹。聚焦 `run-trace.test.js` 通过,`npm run check` 通过。
- [x] 07-E4b 真实运行 trace 接入:`agent-stream` 为每个 run 创建 `RunTrace`,`tool-loop` 在模型调用前、工具决策后、工具结果后发布 `run_trace` 事件;trace 记录走脱敏/截断,失败不影响主循环,可通过 run events 回放真实执行轨迹。
- [x] 07-G1 InjectionGuard:新增 `kimi/safety/untrusted-content.js`,工具结果回灌前统一包成不可信数据区;检测到 prompt injection/tool hijack/exfiltration/approval bypass 模式时发 `untrusted_content_flagged`,并用 tool-loop 注入用例锁定恶意工具输出不会诱导 Shell。
- [x] 07-G2 工具参数 schema 校验:新增 `kimi/agent/arg-validator.js`,tool-loop 在 handler/hook/审批前校验模型工具参数;缺字段/类型错会发 `tool_args_invalid` 并回灌错误,不会执行 handler。
- [x] 07-G3 红队 eval 回归护栏:复用 A7 redteam 任务集覆盖危险 Shell、路径穿越、间接提示注入、绕审批删除/外传等场景;`npm run eval` 当前 28/28 passed。
- [x] P2-B1 验收补齐:连接器 catalog/管理面板/一键连接已存在;新增 `npm run smoke:react-connectors` 真实浏览器验收,覆盖打开连接器面板→一键连接内置 filesystem MCP→`mcp__fs__read_text` 进入工具 registry。
- [x] P2-B2(本地可测子项):新增 GitHub OAuth device-flow 连接器、`/api/connectors/oauth/{status,start,complete,revoke}`、服务端 device-code session 与 Host 凭证仓库;Windows 默认 DPAPI 保护 access token,状态/撤销只返回脱敏摘要;前端连接器面板已支持开始授权、完成授权、撤销授权。`smoke:react-connectors` 用本地 mock GitHub device-flow 覆盖 UI 闭环和凭证不泄漏。
- [x] P2-B2(未配置预检):`/api/connectors/oauth/status` 明确返回 GitHub OAuth client id 配置状态和所需环境变量;`/oauth/start` 在缺少 `KCW_GITHUB_OAUTH_CLIENT_ID` 时返回 428 且不消耗一次性 OAuth scope approval;前端连接器面板在未配置时显示中文提示并禁用授权启动,避免把外部配置缺失误当授权失败。
- [x] P2-B2(client id 来源收紧):GitHub OAuth start 不再接受客户端 body 覆盖 `clientId`,只允许 host `oauthConfig` 或 `KCW_GITHUB_OAUTH_CLIENT_ID`/`GITHUB_OAUTH_CLIENT_ID`;缺配置时即使 body 传入 client id 也 fail-fast 且保留一次性 approval,避免把 OAuth App 身份变成 UI/API 输入面。
- [x] P2-B2 外部验收工具:新增 `smoke:react-connectors:live-github`,在保留本地 mock 连接器 smoke 的基础上禁用 OAuth mock、读取 GitHub OAuth App client id、展示 device-flow user code、轮询 complete/status/revoke 并写脱敏报告;真实账号授权仍需外部 client id 后运行留证。
- [x] P2-B3(本地可测子项):连接器支持断开/撤销;断开 filesystem MCP 会关闭 client 并从工具 registry 移除 `mcp__fs__*`;OAuth 连接器支持 allowlist scope 审批、单次 approval receipt、高风险 scope 标记与前端审批控件;`smoke:react-connectors` 已覆盖连接→断开→工具撤销→GitHub OAuth scope 审批→授权→撤销。
- [x] P3-A1 OpenAI-compatible provider 基础接入:provider registry 已注册 `openai` 与 `openai/local`,复用现有 chat-completions/SSE 解析链路;OpenAI provider 无 key fail-closed,本地 OpenAI-compatible provider 支持无 key baseUrl/model 调用。新增 fake fetch 单测覆盖请求体、鉴权头、流式解析和本地 provider 不发送 authorization;真实多 provider 任务切换、fallback 和统一 BYO-key 设置仍留给 P3 后续子项。
- [x] P3-A2 provider 配置选择与运行留痕:`resolveKimiApiConfig` 支持 `KCW_MODEL_PROVIDER`/`KIMI_PROVIDER` 与 host `kimiProvider/modelProvider`, `/api/kimi/config` 可持久化 provider 且不回显 key;agent/chat/plan run record 与 agent config snapshot 均记录 provider,便于后续 P3-B fallback 与 P3-C 成本按 provider 归因。新增配置 API 与 agent stream E2E 覆盖 provider 持久化、重启加载和 run record 留痕。
- [x] P3-B1 provider fallback 链:agent 模型调用支持 `fallbacks` 串行降级并复用 per-provider/baseUrl/model circuit breaker;fallback 不继承 primary API key/provider/baseUrl/model,4xx/auth/未配置错误不降级,临时失败/熔断可切下一 provider;`model_fallback` 事件只发脱敏摘要。`/api/kimi/config` 可持久化 fallback providers 且 info 响应不回显 fallback key。聚焦模型韧性、配置与 tool-loop 测试通过。
- [x] P3-C1 provider 成本归因:运行 metrics 现在记录 `provider` 与 `cost.provider`,成本估算支持 `provider:model` 定价 key;可观测面板的成本卡和模型归因显示 provider,只展示 provider id,不暴露 key/baseUrl/fallback secret。聚焦 host usage/run-metrics 与 UI view-model 测试通过。
- [x] P3-D1 会话级模型覆盖协议:`/api/agent/chat/stream` 支持本轮 `modelConfig` 覆盖 provider/model/baseUrl/apiKey,无全局 key 时可用本轮 BYO-key 或 `openai/local` 进入;覆盖不持久化,run record 不记录 key,请求体 fallbacks 被忽略。UI API helper 已可透传 modelConfig,可见控件留给 P3-D2。
- [x] P3-D2 会话模型控制面:Composer 输入栏可为本轮选择 provider、填写模型/Base URL/API key,发送时才组装 `modelConfig` 透传给 agent stream;空字段不覆盖全局默认,BYO-key 不写入 Settings/本地状态。UI 纯函数、App option 组装和静态渲染测试通过;真实跨 provider 任务切换仍需可用外部 key/本地模型环境验收。
- [x] P3-A3 Anthropic/Claude provider:Host 注册 `anthropic`/`claude` alias,把 OpenAI-style messages/tools 转换到 Anthropic Messages API,并把流式 text/tool_use/usage 转回现有 agent `content/tool_calls/usage` 契约;Anthropic env 读取独立于 Kimi 默认 env,无 key/model fail-closed。Composer 与设置页已暴露 Claude provider;API key 不回显,本轮 BYO-key 不持久化。聚焦 host/UI 测试通过,真实 Claude key 端到端验收后补。
- [x] FE-3a 面板级 ErrorBoundary:根应用已有全局 `ErrorBoundary`,本轮补齐 `AppSidePanel` 对 tools/viz/connectors/artifacts/schedules/memory/observability 各侧边面板的独立错误边界和中文 label;新增 UI 单测锁定空面板、boundary 包裹与现有面板内容渲染。
- [x] FE-3b 局部接入(ArtifactsPanel):产物面板的内联空态/错误态已替换为现有 `Empty`/`ErrorState`,错误态保留重新加载入口;新增状态渲染单测。其余面板状态统一继续小切片推进。
- [x] FE-3b 局部接入(SchedulesPanel):定时任务面板的内联空态/错误态已替换为现有 `Empty`/`ErrorState`,错误态保留重新加载入口;新增状态渲染单测。
- [x] FE-3b 局部接入(MemoryPanel):记忆面板的内联空态/错误态已替换为现有 `Empty`/`ErrorState`,错误态保留重新加载入口且不再同时显示空态;新增状态渲染单测。
- [x] FE-3b 局部接入(ToolsPanel):工具面板搜索前空态已替换为 `Empty`,工具调用/参数 JSON 失败结果已替换为 `ErrorState`;成功工具 JSON 结果继续用 preformatted 输出。新增单测覆盖空态、错误态、成功结果和错误分类。
- [x] FE-3b 局部接入(VizPanel):活页渲染失败态已替换为 `ErrorState`,保持原有活页渲染/刷新逻辑;新增单测覆盖默认无错误态与错误态渲染。
- [x] FE-3b 局部接入(ConnectorsPanel):连接器空列表已替换为 `Empty`,连接/断开/OAuth/审批等失败消息已替换为 `ErrorState`;成功、等待和提示消息继续保留 preformatted 输出。新增单测覆盖空态、失败态、成功消息和失败分类。
- [x] FE-3b 局部接入(ObservabilityPanel):运行记录列表、详情占位、详情行缺失、工具缺失等空态已替换为 `Empty`,运行记录/详情加载失败已替换为 `ErrorState` 并保留重新加载入口;新增状态渲染单测。
- [x] FE-3b 局部接入(InlineViz):内联图表加载态/错误态已替换为 `Loading`/`ErrorState`,保持 `renderViz` 调用和 iframe 渲染逻辑;新增状态渲染单测。
- [x] FE-3b 局部接入(LiveArtifactView):活页首次生成中/尚未生成/刷新失败状态已替换为 `Loading`/`Empty`/`ErrorState`,保留 ready note、iframe、自动刷新和打开文件逻辑;新增状态渲染单测。
- [x] FE-3b 代码+单测完成汇总:`Empty`/`Loading`/`ErrorState` 已覆盖主侧边面板与内联可视化/活页状态面;源码扫描已无旧式裸 `panel-error`、`inline-viz-loading` 和“图表渲染失败：”内联错误文案。保留的 `panel-empty` 仅作为列表语义容器包裹 `Empty`,保留的 `panel-result` 仅用于成功/info 的 preformatted 输出;真实长会话/安装版视觉深验后续补。
- [x] FE-4 代码+单测完成:`Timeline` 用户/assistant 消息项已 memo 化,显式 comparator 锁定重渲边界;`App` 侧稳定 approval/regenerate 回调,避免流式 token 更新刷新整条时间线。新增 `Timeline.test.tsx` comparator 单测;真实 profiling 与数百消息长会话验收后续补。
- [x] FE-5 代码+单测完成:`Timeline` 在长会话中复用 `computeVirtualWindow` 只渲当前窗口,保留原 timeline 滚动容器和 sticky-to-bottom 行为;短会话仍全量渲染。新增长会话窗口化单测,真实 profiling/安装版长会话深验后续补。
- [x] FE-6 代码+单测+构建完成:侧边面板、Settings 与运行时依赖子面板已按需 `React.lazy` 加载;Vite manualChunks 已拆出 `vendor-react`、markdown、`panel-*`、Settings 与 RuntimeDependenciesPanel chunk。新增 UI/配置单测,真实 UI build 已验证 chunk 输出;安装版首屏体感后续补。
- [x] FE-2a 局部迁移(SchedulesPanel):建立 `components/panels/` 目录,先迁移无 props 的定时任务面板与测试,同步 `AppSidePanel` lazy import 和 `panel-schedules` 分包规则;其余面板继续小步迁移。
- [x] FE-2a 局部迁移(ObservabilityPanel):可观测面板与状态视图单测迁入 `components/panels/`,同步懒加载入口和 `panel-observability` 分包规则;运行记录 API、空态/错误态与 view-model 行为不变。
- [x] P2 安全补强(viz 持久化写入审批):`/api/viz/render/preview` 先生成活页 artifact 写入计划和一次性 `fileOperationApprovalId`, `/api/viz/render` 落盘必须消费匹配 receipt;缺审批 428、root/spec 不匹配 403, `persist:false` 不受影响。
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
- [ ] 继续:深度优先收尾 P2-B OAuth 真实外部验收;P1-A3 真实 Kimi 多文件留档、05-A2 Office 深操作/真实打开等仍按延期验收清单处理。
