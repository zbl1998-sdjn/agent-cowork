# Dogfood 系统验收矩阵(2026-07-07)

用户视角、低/中/高三难度系统验收。模型:Ollama qwen3:14b(真跑);工作区:临时隔离目录。
所有 bug 均已修复合并(PR #7–#13);最终集成套件 1093 tests / 1092 pass / 0 fail / 1 skip。

## A. 功能 × 难度矩阵

| 功能 | 低 | 中 | 高 | 证据 |
|---|---|---|---|---|
| 对话/聊天 | 打招呼得回复(2+3=5) | 单/多轮问答 | 工具调用→审批→**文件真实落盘**(磁盘 20B) | 浏览器+磁盘 cat |
| 模式·计划 | 切换生效 | 产出 4 步待批准计划,不自动执行 | — | get_page_text |
| 模式·执行 | — | — | 写文件弹**审批门**(本次/本会话/拒绝) | 浏览器截图 |
| 模式·YOLO | 切换生效 | — | 写文件**自动执行不弹审批**(磁盘 26B) | 浏览器+磁盘 |
| 技能/14 recipe | 基本源→合法产出 | 真实长文→合法产出 | 空源熔断/超大源截断/特殊字符转义 | 见 B 节矩阵 |
| 工具面板 | 打开 | 搜"文件"返回工具列表 | (工具调用见对话高难度) | 浏览器 |
| 连接器 | 打开 | 一键连本地 filesystem→已连接 | GitHub OAuth 明示需配 CLIENT_ID | 浏览器 |
| 产物 | 打开(空态正确) | 作用域于 .AgentCowork/artifacts | 核实"空"为设计非 bug | 代码+ls 核实 |
| 记忆 | 打开 | 写入记忆卡片成功 | — | 浏览器 |
| 成本·可观测 | 打开 | 运行记录+明细(succeeded) | token 用量已采集(PR#11) | 浏览器 |
| 定时任务 | 打开(空态+引导) | — | — | 浏览器 |
| 项目 | 打开 | 创建 dogfood项目 | — | 浏览器 |
| 可视化 | 打开(工作台+项目视图) | 成功计数已修正(PR#12) | — | 浏览器 |
| 模型配置 | 切 provider | 填模型 qwen3:14b | 配置模型正确流转(PR#8 修复遮蔽) | 浏览器+run记录 |
| 设置 | 打开(8 tab) | 切 tab | 健康检查完整 selfcheck | 浏览器截图 |
| 深色模式 | 命令面板切换 | 干净渲染 | — | 浏览器 |
| 工作区切换 | 下拉打开 | 选文件夹/粘贴路径,path-policy 校验 | — | 浏览器 |
| 对话管理 | 新建(切回对话视图,PR#10) | 重命名生效 | 导出图标存在 | 浏览器 |
| 命令面板 ⚙K | 打开 | 搜索命令 | 触发设置/模式/面板 | 浏览器 |
| 安全审批门 | — | — | 执行模式弹审批、YOLO 不弹(对比正确) | 浏览器 |

## B. Recipe × 三难度矩阵(14 recipe × 5 用例 = 70,全通过)

难度定义:低=基本单源;中=40 行真实中文长文+CSV;高=空源/超大源(~1.2MB)/特殊字符(XML/注入/emoji/控制符)。
判定:OK(合法产出)与 GUARD-422(需要来源的 recipe 对空源正确熔断)均为通过。

- 需要来源类(meeting-actions/excel-cleaning/reimbursement/contract-summary/feedback-clusters/
  summary-report/excel-rescue-basic/chat-to-action-list):低中 OK,高-空源正确 GUARD-422,
  高-超大/特殊字符 GUARD-422 或合法产出。
- 免来源类(folder-organize/email-draft/boss-summary-onepager/weekly-report-beginner/
  word-make-formal/ppt-from-folder-beginner):低中高全 OK(空源也从 prompt 产出)。
- 全部二进制产物 magic bytes 正确(DOCX/XLSX/PPTX=PK、PDF=%PDF);超大源不崩;
  特殊字符 XML 转义正确、无注入。

## C. 本轮修复(8 个,PR #7–#13,全合并)

1. #7 未配模型盲跑技能 → 清晰引导
2. #8 Ollama 模型遮蔽 404 + 晦涩错误(配好模型却发 catalog 默认名)
3. #9 中文 PDF 护栏(满屏 '?' → 提示)
4. #10 新建对话不切回对话视图
5. #11 流式未采集 token 用量(0 tokens)
6. #12 可视化项目视图"成功"计数漏算 succeeded
7. #13 中文 PDF 完整字体嵌入(CIDFontType2 子集,Chrome 视觉验收中文正确)

## D. 诚实边界

- 中文 PDF 视觉正确性由 Chrome PDF 查看器人工验收(截图);单测校验结构与体积。
- 沙箱不隔离网络(selfcheck 黄色警告)为既有设计,非本轮引入。
- 浏览器扩展渲染中途不稳(截图偶超时),靠新标签/重试恢复,非 app bug。
