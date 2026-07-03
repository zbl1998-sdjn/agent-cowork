# Agent Cowork 2.3 小白办公 MVP 收口记录

日期：2026-07-03
范围：`plan/Agent_Cowork_2.3_小白用户日常办公协作傻瓜化优化计划.md` 的两周 MVP / P0-P1 可本地验证切片。

## 已完成

- 小白首页：新增日常办公入口、文件篮说明、Office 急救、老板让我整理一下、一步一步来、常见交付结果。
- 小白文案：首页首屏隐藏 provider/model/token/shell/workspace 等专家术语；Composer 高级模型控制默认折叠到“高级”。
- 文件篮入口：复用 Composer 多文件拖入/上传能力，在首页明确提示“拖入上传”和常见输入格式。
- 核心模板 / Recipes：新增 `boss-summary-onepager`、`weekly-report-beginner`、`excel-rescue-basic`、`word-make-formal`、`ppt-from-folder-beginner`、`chat-to-action-list`。
- Office 副本优先：新增 recipe 输出 Word / Excel / PPT / PDF / TXT / CSV 等常用办公产物，并在输出文本中说明不会覆盖原文件。
- 任务模板可见文案：把“导入 JSON 模板”调整为“小白可理解的任务模板文件”，内部 JSON 导入实现不变。
- 覆盖测试：补齐 BeginnerHome、Composer、AppComposerDock、recipe registry、server recipe route、skill registry 测试。

## 真实验证

- `node scripts/run-host-node.mjs --cwd apps/host -- --test --test-isolation=process --test-timeout=60000 --import ../../scripts/test-setup.ts "test/recipe-registry.test.ts" "test/server.test.ts"`：通过，24/24。
- `npm --prefix apps/windows-client/ui run test -- BeginnerHome AppComposerDock Composer`：通过，27/27。
- `npm run test:ui`：通过，78 个测试文件，356 个测试。
- `npm run test:host:coverage:90`：通过，976 个测试，975 通过，1 个 Docker 真实镜像门控测试按现有配置跳过；总行覆盖率 94.31%。
- `npm run check`：通过，架构、文件大小硬门禁、密钥扫描、类型、lint、资源 JS、TS 覆盖、语言服务、图标检查均通过；仍有既有 soft filesize warnings。
- `npm run build:ui`：通过，Vite 生产构建产出 `apps/windows-client/ui-dist`。

## 未计入完成

- P2：小白记忆、每周提醒、能力包按需安装需要继续按运行时和安装器验收拆分。
- P3：飞书、钉钉、企业微信、腾讯会议、WPS/Office 连接器需要外部账号/真实连接器验收，未在本轮计作完成。
- P4：屏幕辅助、教学录制、可暂停/可撤销屏幕操作属于高风险真实桌面能力，未在本轮计作完成。
- 安装版 Tauri 深验、真实 Office 应用打开文件、真实外部模型/连接器端到端不在本轮验证范围内。
