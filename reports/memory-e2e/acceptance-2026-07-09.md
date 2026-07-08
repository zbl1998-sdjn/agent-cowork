# 自带记忆 · 真机端到端验收(MASE off + 真实模型)

- 日期:2026-07-09
- 分支:`feat/builtin-memory-consolidation`
- 环境:MASE-off dev host(`MASE_MCP_ENABLED=0`,`TRUSTED_ROOT=C:\Users\Administrator`,PORT=3017,
  跑分支源码)+ 真实模型 `kimi-api / kimi-k2.6`(hasKey=true)。
- 前置确认:`/api/tools` mase 工具数 = 0(MASE 确实关闭)。

## 验收流程与真实输出

1. **conv-A 陈述事实(4 轮缓冲)**
   - `A1> 收到，项目代号「银河X9」已记住。`
   - `A2> 收到，已记住：项目架构师是老李。`

2. **conv-B 切换对话**(读缝惰性触发 conv-A 后台提炼)
   - `B1> 今天是 2026 年 7 月 9 日，星期四…`

3. **后台提炼(真实 kimi 调用,12s 内完成)** —— knowledge.json 产物(见 knowledge-e2e-2026-07-09.json):
   - `[active] [项目] 项目代号: 项目代号是「银河X9」 (95%)`(provenance.sourceConversationId=e2e-A)
   - `[active] [项目] 项目架构师: 该项目的架构师是老李 (95%)`
   - 防污染:conv-B 的「今天几号」闲聊未被提炼成知识(只抓了耐用项目事实)。

4. **conv-C 全新对话召回**
   - 问:`我之前在别的对话里说过我们的项目代号,你还记得是什么吗?只回代号本身。`
   - `C1> 银河X9` —— **contains 银河X9: true** ✅

## 结论

MASE 关闭下,agent cowork 用自带记忆系统:
- 对话缓冲提供同会话连续性(P1);
- 切换对话时真实模型把上一对话自动提炼成主题知识、置信度门/去重/溯源生效(P2);
- 全新对话按相关性把主题知识召回注入,模型据此正确回答(P3)。

**核心诉求「关掉 MASE 也能把对话总结、在新对话里想起之前说的、且不污染」在真机真实模型上验证通过。**

## 验收边界

- 本验收在 dev host(分支源码)+ 真实模型上完成;安装版打包(SEA 重构)未在本轮重建,
  合并后需重打包安装版并复跑安装版冒烟。
- 测试数据(knowledge.json / e2e-* 对话缓冲)验收后已从工作区清理,knowledge.json 产物留存
  本目录作证据。
