# Open Cowork 参考改进记录

> 日期：2026-05-20  
> 目标：只吸收产品与工程模式，不复制 Open Cowork 的代码、协议或品牌资产；Agent Cowork 继续保持 Kimi-only、本地可信工作区、审批后执行。

## 参考点

- OpenCoworkAI/open-cowork 强调多 Agent 聊天、MCP 工具、自定义 Skills/Recipes、可切换兼容 OpenAI API 的模型提供方。
- opencowork.me 对同名 local-first runtime 的表达重点是结果优先、可配置模型、MCP、skills、recipes，以及本地运行。

这些方向对 Agent Cowork 的启发是：不要只做一个聊天壳，而要把每次任务运行变成可追踪、可复跑、可扩展的本地工作流单元。

## 已落地

1. **Kimi CLI 运行记录**
   - 每次 `POST /api/kimi/plan` 都生成 `runId`。
   - 成功和失败都会写入 `.KimiCowork/runs/<runId>.json`。
   - 记录内容包含模式、可信工作区、输入摘要、耗时、结果或错误。

2. **运行记录 API**
   - `GET /api/runs` 列出最近运行。
   - `GET /api/runs/<runId>` 读取单次运行详情。

3. **前端可观察性**
   - 协作/代码面板显示 Kimi CLI 是否启用。
   - Kimi CLI 成功时显示运行记录短 ID 和耗时。
   - Kimi CLI 失败降级时仍保留失败 runId，便于定位 `.KimiCowork/runs/*.json`。

4. **Cowork handoff**
   - 首页或“对话”页点击发送会自动切到“协作”工作台。
   - 主输入创建透明计划、操作预览和审批状态，不再停留在普通聊天气泡。
   - 快速连续发送使用毫秒级唯一产物名，避免同一秒内计划文件冲突。

5. **执行动态信息流**
   - 协作面板显示用户指令、读取本地上下文、Kimi 计划返回、等待审批、执行完成。
   - Kimi CLI 成功时把计划摘要、runId 和耗时显示在同一条任务流里。
   - 上传文件后也会在任务流里显示导入结果和下一步等待状态。

6. **前台任务卡片**
   - 协作/代码面板直接拉取 `GET /api/runs`，展示最近 Kimi run 的类型、状态、耗时和短 ID。
   - 发送任务后会刷新并高亮最新 run，不再只把运行记录藏在 `.KimiCowork/runs/*.json`。
   - 点击任务卡片会读取 `GET /api/runs/<runId>`，把输入摘要、Kimi 输出或错误展开到执行动态区。

## 下一批建议

## 技术栈修正

用户反馈后，当前方向调整为：

- 桌面框架：优先评估 Electron 或 Tauri。
- 前端 UI：React + Tailwind，用于替换当前静态 HTML/JS 原型。
- Agent 核心：保持 Kimi-only，不能切成 Claude API；通用方案里写的 Anthropic Claude API 只作为外部参考，不进入本产品核心路径。
- 工具协议：MCP，用于标准化工具扩展。
- 沙箱执行：Docker / Hyper-V / WSL2，根据 Windows 普通用户安装成本分阶段引入。
- 本地数据库：SQLite，用于任务历史、运行记录、配置、授权目录。

当前先修 MVP 可用性：上传文件 / 文件夹、发送消息跳转 Cowork、执行动态信息流、前台任务卡片、Kimi CLI 计划、运行记录。之后再做 Electron/Tauri + React/Tailwind 的工程迁移。

1. **Run Detail 面板**
   - 在“产物”页加入更完整的运行记录列表。
   - 从任务卡片继续扩展出模型/CLI 命令、原始 run JSON、复跑入口和关联产物。

2. **Recipe / 模板**
   - 把常用任务沉淀为 `recipes/*.json`，例如合同摘要、会议纪要、发票整理、代码审查。
   - 模板只保存任务结构，不保存用户隐私文件内容。

3. **Skill 注册表**
   - 定义 Kimi-only skill manifest：名称、适用文件类型、需要权限、输出产物类型。
   - 前端“自定义”页可启停 skill。

4. **MCP/工具策略**
   - 后端加入 tool policy：默认禁用网络和命令，高风险工具必须二次审批。
   - 每个 tool call 进入 run record。

5. **复跑与回滚**
   - 支持从 run record 复跑只读计划。
   - 审批执行后的 apply batch 和 rollback journal 与 runId 关联。
