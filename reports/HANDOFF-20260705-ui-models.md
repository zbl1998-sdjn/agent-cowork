# 交接文档 — Agent Cowork:UI 重度对齐 Claude + 模型选择器 + 竞品对比

- **日期**:2026-07-05
- **分支**:`feat/mase-memory-backend`
- **范围**:本会话围绕三条线——(A) 前端重度对齐 Claude cowork 的三栏布局;(B) 模型厂商补齐 + 模型选择器改精选;(C) 与腾讯 WorkBuddy 的竞品对比。
- **接手第一步**:先读「四、已知坑」再动手,尤其 host 重启 / exe 缓存两条,否则你会看到"改了没生效"的假象。

---

## 一、已完成并已提交(本会话 11 个 commit,从旧到新)

| commit | 内容 |
|---|---|
| `b945a86` | release 构建 dev 护栏(杜绝生产版连 dev server) |
| `633770f` | 统一按钮系统 + 主色回暖陶土橙(去组件内联样式) |
| `87782ee` | 设置「默认模型」改按厂商列全部可选模型 |
| `bf6b1e8` | 修顶栏 ⌘K/⚙/更多 入口整块不可见(`margin-left:auto` 挤出) |
| `461a52bb` | 重度对齐 Claude 侧栏导航中心 + 拆分 3693 行 styles.css 为 18 模块 |
| `10b8cf8` | 删 workbench 层死代码 -103 行 |
| `e6895c4` | 侧栏撑满高度 + New chat 边框弱化;footer 记为已知瑕疵 |
| `34fcd7d` | 聊天区(去气泡框)+ 输入框 + 右侧面板对齐 Claude |
| `07fa15f` | 侧栏收放 + 面板切主区 + 去侧栏 footer |
| `da5f99f6` | 补齐 Claude 三栏右栏(AppContextRail)+ 底部输入框平铺 |
| `06b6d9ae` | 后端 catalog 补齐国际厂商 16→22(models.dev) |

竞品对比 Artifact(未进 git,已发布):`reports/agent-cowork-vs-workbuddy.html` → https://claude.ai/code/artifact/789abe2e-b614-4021-a4af-28741a82e37e

---

## 二、已完成但未提交(工作树里,可直接接着做)

**「模型选择器改精选下拉 + 模态/上下文标注」** — 已把精选模型从纯 ID/标签扩展为用户可读的 `modality + context` 标注,并补了数据回归测试。

未提交文件:
- `apps/windows-client/ui/src/lib/model-highlights.ts`(新)— 22 厂商精选数据,每模型 `{id, modality, context, tags[], note}`
- `apps/windows-client/ui/src/lib/model-highlights.test.ts`(新)— 6 个数据测试
- `apps/windows-client/ui/src/components/ComposerModelControls.tsx`(改)— input+datalist → 精选菜单 + 手输
- `apps/windows-client/ui/src/components/Composer.test.tsx`(改)— 断言从 datalist 改成 model-picker
- `apps/windows-client/ui/src/styles/17-claude-align.css`(改)— `.model-menu` / `.model-tag` 语义色

状态:2026-07-05 本轮 focused tests 已通过:模型标注/上下文压缩相关 UI 5 files / 71 tests passed,host agent-stream/context 7 tests passed；随后 FileSummaryCache 与 controlled handoff MVP 均已补齐本地闭环,`npm run check`、focused orchestrator tests、office-team/ppt-from-folder smoke 与 `python -X utf8 scripts\quality_gate.py --level full` 均已复跑通过。
commit message 草稿:`<scratchpad>/commit-highlights.txt` 如继续使用,需按本轮新增 context compaction 更新。

---

## 三、已完成与剩余边界(用户明确要求)

### #0 模型清单当前性审计已补做,旧表不能直接用
- **新证据**:`reports/model-currentness-audit-20260705.md`
- **结论**:第五节的 models.dev/context 表只能当历史草稿,不能再按"已查好,别再重查"推进。2026-07-05 重新联网核验后,修复前 UI 精选、host catalog、models.dev 默认 hint、设置页 fallback 都有过时或不一致模型。
- **高风险例子**:`gemini-3-pro-preview` 已被 Google 文档列为 Previous/shutdown;DeepSeek `deepseek-chat`/`deepseek-reasoner` 官方写明 2026-07-24 retiring;Kimi `kimi-k2-thinking`/`kimi-k2-turbo-preview` 官方 deprecated;OpenAI 精选原先停在 `gpt-5.2`/`gpt-image-1`;官方当前可广泛默认使用 `gpt-5.5`/`gpt-5.5-pro`/`gpt-image-2`,而 `gpt-5.6` 只按 trusted preview 记录,不能作为默认。
- **接手要求**:模型 ID 与 modality/context 已按新审计报告修正;后续维护时继续以 `reports/model-currentness-audit-20260705.md` 和当前官方来源为准,不要把旧第五节表直接覆盖进代码。

### #1 模型标注加「模态(语言/多模态)+ 上下文长度」 ← 已完成
- **实现**:`ModelHighlight` 已包含 `modality: '语言' | '多模态'` 与 `context`;精选菜单展示 `多模态 · 400K` 这类短标签,未知自定义模型回落为 `语言 · 自定义`。
- **数据口径**:按 `reports/model-currentness-audit-20260705.md` 修正后的当前推荐模型填充,不再直接搬旧第五节草表。
- **回归**:`apps/windows-client/ui/src/lib/model-highlights.test.ts` 已断言精选模型都有合法模态和非待确认上下文,并钉住 OpenAI/Kimi/DeepSeek 关键项。

### #2 自动压缩上下文功能 ← 已完成
- **实现**:host `agent-stream` 接收 `contextCompaction`/兼容旧 flag,调用 `runAgentChat` 的上下文预算选项;长历史会压缩为 `history_compactor` 摘要并发出 `context_compacted` SSE。
- **前端**:设置页新增“自动压缩上下文”开关,默认开启并持久化到 localStorage;流式回调会显示 `已自动压缩上下文:X tokens -> Y tokens` 进度。
- **失败边界**:关闭开关时 host 传入超大 `maxContextTokens` 避免自动压缩;压缩统计只作为进度事件,不替代记忆系统或外部长期 memory。
- **回归**:host `agent-stream-input`/`tool-loop-context` focused tests 已覆盖 schema、禁用路径和长历史自动压缩事件;UI `api`/`app-logic`/`chat-stream-callbacks`/`SettingsTabsContent` tests 已覆盖请求体、SSE、设置开关和进度文本。

---

## 四、已知坑 / 阻塞(务必先看)

### 架构债务审计补充(2026-07-05)

- 编排层现在由大 option 包 + 多个可变标志位驱动:`apps/host/src/kimi/agent/tool-loop.ts` 的 `RunAgentChatOptions` 和 `apps/host/src/kimi/agent/tool-call-executor.ts` 的 `ExecuteToolCallOptions` 已经接近隐式状态机。当前能跑、可测,但下一轮应拆成显式状态机/transition,不要继续往 option bag 塞能力。
- Provider 类型接缝已收口:`apps/host/src/kimi/provider/types.ts` 现在导出强类型 `ProviderChatResult`/`ProviderToolCall`/`ProviderUsage`;`apps/host/src/kimi/provider/result.ts` 把外部 JSON 的 unknown 归一化在 provider 边界内,Kimi/OpenAI-compatible/Anthropic 三条路径已通过 `test/model-provider.test.ts` 回归。输入侧 `messages/tools/kimiConfig` 仍保留 unknown,因为它们来自请求/配置边界,不能假装已可信。
- 维护面过宽:`apps/host/src` 覆盖 runtime/routes/storage/security/providers/artifacts/recipes/sandbox 等大量子系统,`routes`/`recipes`/`artifacts` 都需要按核心价值重新裁剪,避免个人项目继续 scope creep。
- 展示前清理学习痕迹:已把 `tool-loop.ts` 的大段 Derrick 学习注释改成中性技术注释,并把 `MessageBubble.tsx` 的硬编码用户 Derrick 改成通用用户标识;后续仍应 `rg "Derrick|学习注释|大白话"` 全仓复扫。
- 范围诚实:本次审计是承重文件深抽样 + 全仓计数/定点搜索,不是 297/297 每个文件逐行读。
- 2.5 编排层状态更新:已补 P0/P1 本地可验证闭环和 UI Agent Team Timeline,包括 typed AgentDefinition/AgentResult、AgentRegistry、ContextPacker、BudgetManager、GuardrailEngine、ResultSynthesizer、TraceRecorder、WorkflowRunner、recipe registry、weekly-report/folder-map-reduce/office-team/ppt-from-folder recipes、按租户分区 FileSummaryCache、只读 subagent adapter、typed provider adapter、checkpoint store、`/api/orchestrator/run`/detail/checkpoint/resume/`run-async`/cancel、cooperative cancellation、map_reduce 可运行 agent_task 真并行调度、七条真实 Host HTTP smoke,以及右侧栏 agent 状态/timeline/budget/trust 摘要。当前代码侧/本地门禁已收敛到上线前外部验收边界;当前源码的 `build:host`、Tauri `--no-bundle` 构建、`cargo tauri build --ci --bundles nsis` 完整 NSIS bundle、rebuilt sidecar direct smoke、真实 Kimi API smoke、当前 installer 重装、installed smoke 和 WebView/a11y 深验已补。仍不能称为上线/生产完成,因为生产代码签名、正式 updater endpoint/私钥、clean tag release 复验与产品化发布证据未接。

1. **host 3017 是 exe 启动的旧进程** — 你改了 `apps/host` 的 catalog(22 厂商)后,前端看到的还是旧 16 厂商,因为 host 没重启。dev 验证:先 `kill exe` 再独立跑 host,或 `npm run start:tauri-host`;桌面版要 build host + 重打包 exe。
2. **exe WebView2 缓存** — 桌面版新 UI 不显示时,清 `C:\Users\Administrator\AppData\Local\com.agent.cowork\EBWebView` 再重启 exe(清后会回到登录页,点"跳过,先在本地使用"进主界面)。
3. **cargo 增量不重嵌前端** — `cargo build` 有时不重嵌最新 ui-dist;可靠办法 `cargo clean -p agent-cowork-desktop` 或用 `tauri build`。曾因此误判 footer/右侧栏"不显示"。
4. **footer(设置/主题/安全)在 webview 不渲染** — 已知瑕疵,flex/absolute/cargo clean 都试过无效,疑 webview 深层;已去掉该 footer,设置/主题走顶栏「更多」+ ⌘K。
5. **国内厂商 models.dev 不收录** — 火山/百度/讯飞/腾讯的模型 context/modality 用官方文档公开值,标注"可能随版本更新",都 `allowCustomModel: true` 可手输。
6. **dev server `/api` 不代理到 host** — 浏览器里 `fetch('/api/...')` 返回 SPA;验证 host 数据用 `curl http://127.0.0.1:3017/api/kimi/info`(需 auth,401 属正常),或直接跑后端函数(见命令区)。
7. **点击自动化 DPI 偏移 + webview 黑屏** — 桌面 exe 截图验证时,MoveWindow resize 易黑屏,SetCursorPos 有 DPI 偏移;优先用 dev server + Playwright 验证前端,exe 只做最终确认。

---

## 五、models.dev 模型 context / modality 数据表(旧草表,仅作补充,不可直接覆盖当前数据)

> 数据源:`models.dev/api.json`(2026-07-05 本机下载 `<scratchpad>/models-dev.json`,151 providers);判定规则:`modalities.input` 含 image/audio/video 即「多模态」。注意:本表仍含旧 ID,只能辅助补 context/modality,最终模型 ID 以 `reports/model-currentness-audit-20260705.md` 和当前代码为准。

| model id | context | 模态 |
|---|---|---|
| kimi-k2.7-code | 256K | 多模态 |
| kimi-k2-thinking | 256K | 语言 |
| kimi-k2.6 / k2.5 | 256K | 多模态 |
| kimi-k2-turbo-preview | 256K | 语言 |
| deepseek-v4-pro / v4-flash / chat / reasoner | 1M | 语言 |
| qwen3-max | 256K | 语言 |
| qwen3.7-max | 1M | 语言 |
| qwen3-coder-plus | 1M | 语言 |
| qwen3-vl-plus | 256K | 多模态 |
| qwen3.7-plus | 1M | 多模态 |
| qwen-max | 128K | 语言 |
| glm-5.2 | 1M | 语言 |
| glm-5 / glm-4.7 | 200K | 语言 |
| glm-4.6v | 128K | 多模态 |
| glm-4.7-flash | 200K | 语言 |
| MiniMax-M2.7 / M2.5 | 205K | 语言 |
| MiniMax-M3 | 1M | 多模态 |
| MiniMax-M2 | 197K | 语言 |
| gpt-5.2 / gpt-5.2-codex / gpt-5-pro | 400K | 多模态 |
| o3 | 200K | 多模态 |
| gpt-4o / gpt-4o-mini | 128K | 多模态 |
| gpt-image-1 | —(图像生成) | 多模态 |
| claude-opus-4-8 / sonnet-5 / fable-5 | 1M | 多模态 |
| claude-sonnet-4-5 / haiku-4-5 | 200K | 多模态 |
| gemini-3-pro-preview / 3-flash / 2.5-pro / 2.5-flash / 2.5-flash-lite | 1M | 多模态 |
| grok-4.3 / grok-4.20-* | 1M | 多模态 |
| mistral-large-latest / medium-latest / small-latest | 256K | 多模态 |
| codestral-latest | 256K | 语言 |
| magistral-medium-latest | 128K | 语言 |
| pixtral-large-latest | 128K | 多模态 |
| llama-3.3-70b-versatile / 3.1-8b-instant / gpt-oss-120b / qwen3-32b / groq-compound | 128K | 语言 |
| sonar-pro | 200K | 多模态 |
| sonar-reasoning-pro | 128K | 多模态 |
| sonar / sonar-deep-research | 128K | 语言 |

**国内 4 厂商(models.dev 未收录,官方文档公开值,标注可能过期,均可手输)**:
| model id | context | 模态 | 来源 |
|---|---|---|---|
| doubao-seed-1.6 / -flash | 256K | 多模态 | 火山方舟文档 |
| doubao-seed-1.6-thinking | 256K | 语言 | 火山方舟文档 |
| doubao-1.5-thinking-pro / doubao-1.5-vision-pro | 已从 UI 精选下架 | 语言/多模态 | 旧推荐,仅保留测试防回归 |
| hunyuan-turbos-latest / t1-latest / large / standard | 256K | 语言 | 腾讯云文档 |
| hunyuan-vision | 256K | 多模态 | 腾讯云文档 |
| ernie-5.0 | 长 | 多模态 | 文心官方(具体 ctx 待核) |
| ernie-4.5-turbo-32k / 4.5-8k | 32K/8K | 多模态 | 千帆文档 |
| ernie-x1-turbo-32k | 32K | 语言 | 千帆文档 |
| ernie-speed-128k | 128K | 语言 | 千帆文档 |
| 4.0Ultra / pro-128k / lite / x1(讯飞) | 8K–128K | 语言 | 讯飞开放平台文档 |
| generalv3.5 | 已从 UI 精选下架 | 语言 | 旧推荐,仅保留测试防回归 |

> 国内 context 精确值(尤其火山/讯飞按 endpoint 变)接手前最好再核一遍官方文档,不确定就标"—"或走 allowCustomModel。

---

## 六、验证 / 常用命令

```bash
# 前端(在 apps/windows-client/ui)
npm run build            # typecheck + vite build → ui-dist
npx vitest run           # UI 测试(当前 375 passed)

# 后端 host(在仓库根)
npm run check            # 全门禁:架构/文件大小/密钥/类型/lint/icons(commit 前必过)
# 跑 host 某几个测试(node:test,不是 vitest!):
node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../scripts/test-setup.ts "test/model-provider-catalog.test.ts" "test/model-provider.test.ts"
node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../scripts/test-setup.ts "test/orchestrator-routes.test.ts" "test/orchestrator-runtime.test.ts"
node scripts/run-host-node.mjs scripts/smoke-orchestrator-weekly-report.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-map-reduce.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-office-team.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-resume.ts
node scripts/run-host-node.mjs scripts/smoke-orchestrator-async-cancel.ts

# 直接跑后端 catalog 逻辑(查各厂商实际返回,曾用它定位"模型变少"):
# 写个临时 ts import modelsDevProviderCatalogResponse,用 node scripts/run-host-node.mjs 跑

# 提交(纪律):先清 MASE_* 环境;commit 用 -F 文件;不加 --no-verify
for v in $(env | grep -oE '^MASE_[A-Za-z0-9_]+'); do unset "$v"; done
git commit -F <msg-file>
```

关键文件位置:
- 模型精选数据 `apps/windows-client/ui/src/lib/model-highlights.ts`
- 模型选择器 UI `apps/windows-client/ui/src/components/ComposerModelControls.tsx`
- 后端 provider 目录 `apps/host/src/kimi/provider/{catalog.ts, catalog-data.ts, catalog-types.ts, models-dev-catalog.ts}`
- host 返回 providers 的路由 `apps/host/src/routes/kimi-route-support.ts`(用 `modelsDevProviderCatalogResponse`)
- 对齐样式层 `apps/windows-client/ui/src/styles/17-claude-align.css`(最后 import,覆盖历史样式)
- 三栏布局 `apps/windows-client/ui/src/App.tsx`(左 ConversationRail + 中 app-content + 右 AppContextRail)

---

## 当前来源验证
- 提交链 / 工作树:`git log --oneline`、`git status`(本机,2026-07-05)
- 模型 currentness:OpenAI/Moonshot/Google/DeepSeek/xAI/OpenRouter 官方或公开 API 于 2026-07-05 复核;context/modality:`models.dev/api.json`(2026-07-05 本机下载,151 providers,Node 解析两批查询,仅作补充)
- 国内 4 厂商模型:火山方舟 / 腾讯云 / 百度千帆 / 讯飞开放平台官方文档(WebSearch 2026-07-05),精确 context 标注"可能随版本更新,需接手前复核"
- 前端验证:2026-07-05 UI Agent Team Timeline 后 `python -X utf8 scripts\\quality_gate.py --level full` 已通过;其中 `smoke:playwright-all` 写入 `output/playwright/agent-cowork-all-smoke-report.json`,`test:ui` 375 passed
- 编排层验证:2026-07-05 `node scripts/run-host-node.mjs --cwd apps/host -- --test --test-isolation=process --test-timeout=60000 --import ../../scripts/test-setup.ts "test/orchestrator-runtime.test.ts" "test/orchestrator-routes.test.ts"` 22 passed;`node scripts/run-host-node.mjs scripts/smoke-orchestrator-weekly-report.ts` / `scripts/smoke-orchestrator-map-reduce.ts` / `scripts/smoke-orchestrator-office-team.ts` / `scripts/smoke-orchestrator-ppt-from-folder.ts` / `scripts/smoke-orchestrator-summary-cache.ts` / `scripts/smoke-orchestrator-resume.ts` / `scripts/smoke-orchestrator-async-cancel.ts` passed,其中 office-team/ppt-from-folder smoke 已断言 `handoff_started` 6/5 个事件、contextRefs 与 budget；证据 `output/smoke/orchestrator-weekly-report.json`、`output/smoke/orchestrator-map-reduce.json`、`output/smoke/orchestrator-office-team.json`、`output/smoke/orchestrator-ppt-from-folder.json`、`output/smoke/orchestrator-summary-cache.json`、`output/smoke/orchestrator-resume.json`、`output/smoke/orchestrator-async-cancel.json`
- UI Agent Team Timeline 验证:2026-07-05 `npm --prefix apps/windows-client/ui run test -- agent-team-timeline AgentTeamTimeline AppContextRail` passed,3 files / 7 tests
- 桌面 exe / host 相关坑:本机实测(cargo clean、EBWebView 清缓存、host 旧进程),非推测
- 当前源码桌面构建证据:2026-07-05 用户授权收口后 `npm --prefix apps/windows-client/ui run build` 通过并刷新 `apps/windows-client/ui-dist`;`npm run build:host` 通过并刷新 Tauri sidecar;`cargo tauri build --ci --bundles nsis` 通过,`prepare-embedded-python.ps1` 成功 staging Python 3.12.10 并生成 NSIS installer `apps/windows-client/src-tauri/target/release/bundle/nsis/Agent Cowork_0.2.0_x64-setup.exe`。Cargo 仅报 bin/lib PDB filename collision warning,未阻断构建。
- 当前源码 sidecar direct smoke:2026-07-05 `reports/windows-client-smoke/current-sidecar-smoke-20260705T085841Z.json` ok=true,独立端口 3998 覆盖 `/health`、guest auth、`/api/kimi/info`、SQLite runtime、embedded Python runtime,并确认本次启动进程已停止且端口释放。
- 当前源码 NSIS installer 证据:2026-07-05 用户授权收口后产物大小 79,222,537 bytes,LastWriteTimeUtc `2026-07-05T14:21:56.9391186Z`,SHA256 `9B19D12DD00A3DAC9A86C78D3FF01BCD83F02F16EFBDF9CF880DDC0784D5D6A5`;`Get-AuthenticodeSignature` = `NotSigned`;bundle 目录仅含 NSIS setup。`createUpdaterArtifacts=false` 与 `UPDATES_CONFIGURED=false` 匹配当前占位 updater endpoint,正式 endpoint/签名私钥接入前不生成 updater 发布包。
- 真实 Kimi provider smoke:2026-07-05 用户授权后加载 `.env` 中真实 `KIMI_API_KEY` 运行 `node scripts/run-host-node.mjs scripts/smoke-kimi-api.ts` 通过;证据 `build/kimi-api-smoke-report.json`,model `kimi-k2.7-code`,baseUrl `https://api.moonshot.cn/v1`,runId `run_20260705141206_77c6936b`,durationMs 13955。
- 已安装版部署验证:2026-07-05 用户授权后用当前 NSIS installer 静默重装,`scripts/smoke-installed-tauri.ps1` 通过并写入 `reports/windows-client-smoke/installed-tauri-smoke-20260705T142258Z.json`;覆盖 current-user install、WebView2 bootstrapper config、NSIS cleanup hook、installed exe/sidecar、host health、guest auth、`/api/kimi/info`、SQLite write chain、embedded Python、restart persistence 与 cleanup。installed app 观测到 `kimi.configured=true`,provider `kimi-api`,model `kimi-k2.7-code`。
- 已安装 WebView/a11y 深验:2026-07-05 `node scripts/run-host-node.mjs scripts/smoke-installed-a11y.ts` 通过并写入 `reports/windows-client-smoke/installed-a11y-2026-07-05-142323Z.json`;`viewsScanned=20`,`contrastIssues=0`,`mobileComposerOk=true`,`overflowIssues=[]`。生产代码签名、正式 updater endpoint/私钥、clean tag release 复验与发布证据仍属上线前待验收。



---

## 七、2026-07-05 本轮收口验证

- 本轮已按当前官方/公开来源重新核验模型 ID,修正 UI 精选、host catalog、models.dev hints、设置 fallback 中的高风险旧模型。
- 本轮已补 `qwen2.5:0.5b` 到本地精选,因为当前 full smoke 使用本机已安装小模型做低成本真实 Ollama 路径验证;这不是重新引入 DeepSeek R1 旧项。
- 本轮 focused provider 证据:`node scripts/run-host-node.mjs --cwd apps/host -- --test --import ../../scripts/test-setup.ts "test/model-provider.test.ts" "test/model-provider-catalog.test.ts" "test/orchestrator-runtime.test.ts"` 通过,35 tests passed；ProviderChatResult typed parse 已覆盖 Kimi/OpenAI-compatible/Anthropic 与 orchestrator provider adapter。
- 本轮 focused UI 模型证据:`npm --prefix apps/windows-client/ui run test -- src/lib/model-highlights.test.ts` 通过,1 file / 6 tests；`doubao-1.5-thinking-pro`、`doubao-1.5-vision-pro`、`generalv3.5` 已从 UI 精选下架,只作为 stale regression set 保留。
- 本轮 repo gate 证据:FileSummaryCache 与 controlled handoff 新增后 `npm run check` 通过；focused orchestrator tests 22 passed；office-team smoke 写入 `output/smoke/orchestrator-office-team.json` 且 handoffs=6；ppt-from-folder smoke 写入 `output/smoke/orchestrator-ppt-from-folder.json` 且 handoffs=5；`python -X utf8 scripts\quality_gate.py --level full` 已复跑通过,覆盖 `security:local-strict`、`build:ui`、`smoke:playwright-all`、`ci`、`test:host` 1019 passed / 1 skipped、`test:ui` 375 passed、`eval` 28/28。
- 真实 Kimi key smoke 已在用户授权后执行:加载 `.env` 后用 `kimi-k2.7-code` 调用 `https://api.moonshot.cn/v1` 成功,证据 `build/kimi-api-smoke-report.json`。
- 仍然不能说“2.5 多 Agent 编排上线/生产完成”:本轮已新增正式 `apps/host/src/orchestrator/` typed runtime、`/api/orchestrator/run`、`/api/orchestrator/run-async`、tenant scoped detail、checkpoint/resume、cooperative cancel、只读 subagent adapter、typed provider adapter、ProviderChatResult typed parse、folder-map-reduce/office-team/ppt-from-folder recipes、按租户分区 FileSummaryCache、controlled handoff `handoff_started` trace、map_reduce 真并行调度、七条 orchestrator HTTP smoke、UI Agent Team Timeline、模型模态/上下文标注和自动压缩上下文；当前源码 `build:host`、Tauri `--no-bundle` 构建、NSIS installer bundle、rebuilt sidecar direct smoke、真实 Kimi API smoke、installed smoke 和 WebView/a11y 深验已过。但安装包/installed desktop/sidecar 均为 `NotSigned`,正式 updater endpoint/私钥未接,clean tag release 复验与产品化发布证据仍未完成。

## 八、2026-07-06 真实 Kimi / 安装版收口

- 新增证据汇总:`reports/acceptance-record-20260706-kimi-installed-signing.md`。
- 本地已闭合:真实 Kimi API smoke、当前 UI/host/NSIS rebuild、当前 installer 静默重装、installed Tauri smoke、installed WebView/a11y 深验、installer/desktop/sidecar 签名状态复核。
- 仍是外部发布阻塞:真实 CA 代码签名证书或 PFX、Tauri updater 私钥/产物生成、正式 HTTPS updater endpoint、clean tag release 复验与发布证据。
