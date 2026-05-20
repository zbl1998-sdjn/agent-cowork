# Open Cowork 参考改进记录

> 日期：2026-05-20  
> 目标：只吸收产品与工程模式，不复制 Open Cowork 的代码、协议或品牌资产；Kimi Cowork 继续保持 Kimi-only、本地可信工作区、审批后执行。

## 参考点

- OpenCoworkAI/open-cowork 强调多 Agent 聊天、MCP 工具、自定义 Skills/Recipes、可切换兼容 OpenAI API 的模型提供方。
- opencowork.me 对同名 local-first runtime 的表达重点是结果优先、可配置模型、MCP、skills、recipes，以及本地运行。

这些方向对 Kimi Cowork 的启发是：不要只做一个聊天壳，而要把每次任务运行变成可追踪、可复跑、可扩展的本地工作流单元。

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

## 下一批建议

1. **Run Detail 面板**
   - 在“产物”页加入运行记录列表。
   - 点击 runId 展示输入摘要、模型/CLI 命令、耗时、错误、生成文本。

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
