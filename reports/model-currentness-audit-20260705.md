# Agent Cowork 模型当前性审计 - 2026-07-05

## 结论先行

这批模型不能按 `reports/HANDOFF-20260705-ui-models.md` 里的“已查好,别再重查”继续推进。当前在线核验发现,修复前 UI 精选表、host 内置 catalog、models.dev fallback hints、设置页 fallback 之间同时存在过时 ID 和来源不一致。

高风险项:

- Google: `gemini-3-pro-preview` 已被 Google 文档列到 Previous models,并写明 2026-04-29 shutdown;修复前 UI、host catalog、models.dev hints 都还在用。
- DeepSeek: 官方价格页写明 `deepseek-chat` / `deepseek-reasoner` 在 2026-07-24 退役;修复前 UI 仍把它们当常规精选。
- Kimi: 官方文档把 `kimi-k2-thinking`、`kimi-k2-turbo-preview` 标为 deprecated;修复前 UI 精选仍保留。
- OpenAI: 官方模型页显示 `gpt-5.6` 属 trusted preview,不适合做广泛默认;修复前 UI 精选和多个默认提示仍停在 `gpt-5.2` / `gpt-5.2-codex` / `gpt-image-1`,应换到广泛可用的 `gpt-5.5` / `gpt-5.5-pro` / `gpt-5.3-codex` / `gpt-image-2`。
- 火山方舟:官方导航已出现 Seed 2.1,项目仍展示 Seed 1.6 / 1.5 系列。
- xAI: `grok-4.3` 是当前模型,但项目里的 `grok-4.20-0309-reasoning` / `grok-4.20-0309-non-reasoning` 不是 xAI 官方模型列表里的当前 ID;OpenRouter 当前也只暴露 `x-ai/grok-4.20`、不是带 `0309` 的 ID。
- OpenRouter:公开 `/api/v1/models` 当前不包含 `google/gemini-3-pro-preview`;包含 `google/gemini-3.5-flash`、`anthropic/claude-opus-4.8`、`anthropic/claude-sonnet-5`、`x-ai/grok-4.20`、`x-ai/grok-4.3`。
- SiliconFlow:官方 `/v1/models` 需要 token,本次未能无凭据拉全量列表,因此不能把 siliconflow-cn 的精确 ID 判为官方通过。

## 审计范围

实际命中模型清单的位置:

- `apps/windows-client/ui/src/lib/model-highlights.ts`:新 UI 精选菜单,22 个 provider、104 个精选模型。
- `apps/host/src/kimi/provider/catalog-data.ts`:host 内置 provider/model catalog,应用真实 fallback。
- `apps/host/src/kimi/provider/models-dev-catalog.ts`:models.dev 适配器默认模型提示,当前仍含 Google/OpenAI/xAI 旧默认。
- `apps/windows-client/ui/src/components/SettingsTabsContent.tsx`:设置页 provider fallback,本地模型默认仍以 `qwen2.5` 为主。
- 旧报告/验证材料中出现的模型 ID 只作为历史证据,不作为当前推荐清单直接修改。

架构边界:前端不能直接 import host catalog。后续修正应分别更新 UI 精选表和 host catalog/adapter,再通过现有 HTTP/SSE provider catalog 契约流到 UI。

## 判定口径

- 最新:官方当前文档/API 明确在 current/latest/top family,或聚合 provider 的官方 API 当前存在且同 provider 没有更合适的同类替代。
- 可用非最新:仍在官方/API 列表或公开 API 可见,但已经有更高版本、更新 family 或更合适的默认。
- 过时/高风险:官方写 deprecated/shutdown/retiring,或当前 API 已不含该 ID,或文档只把它列为 previous/legacy。
- 官方未确认:公开文档/API 无法无凭据确认 exact ID,只能从 models.dev/OpenRouter/上游 provider 推断。
- 本地/自定义:取决于用户本机安装或自建网关,不按云端“最新模型”直接判定。

## 逐项模型判定

| provider | model id | 结论 | 当前建议 |
|---|---|---|---|
| kimi-api | `kimi-k2.7-code` | 最新 | 保留;可加 `kimi-k2.7-code-highspeed` 作高速项 |
| kimi-api | `kimi-k2-thinking` | 过时/高风险 | 官方标 deprecated;换 `kimi-k2.7-code` 或 `kimi-k2.7-code-highspeed` |
| kimi-api | `kimi-k2.6` | 可用非最新 | 保留为稳定 fallback,不要标“最新” |
| kimi-api | `kimi-k2.5` | 可用非最新 | 只作旧版 fallback |
| kimi-api | `kimi-k2-turbo-preview` | 过时/高风险 | 官方标 deprecated;换 `kimi-k2.7-code-highspeed` |
| deepseek | `deepseek-v4-pro` | 最新 | 保留 |
| deepseek | `deepseek-v4-flash` | 最新 | 保留 |
| deepseek | `deepseek-r1` | 过时/高风险 | DeepSeek API 当前推荐用 `deepseek-reasoner` 或 V4;该 ID 更像开源/聚合名 |
| deepseek | `deepseek-chat` | 过时/高风险 | 官方写 2026-07-24 retiring;换 `deepseek-v4-flash` 或 `deepseek-v4-pro` |
| deepseek | `deepseek-reasoner` | 过时/高风险 | 官方写 2026-07-24 retiring;换当前 V4 推理/旗舰路线,上线前再复核 |
| qwen-dashscope-cn | `qwen3-max` | 可用非最新 | `qwen3.7-max` 已更新,默认不该用它 |
| qwen-dashscope-cn | `qwen3.7-max` | 最新 | 保留 |
| qwen-dashscope-cn | `qwen3-coder-plus` | 最新 | 保留 |
| qwen-dashscope-cn | `qwen3-vl-plus` | 可用非最新 | 保留为简化别名;host catalog 已有 `qwen3-vl-235b-a22b` 等更精确 ID |
| qwen-dashscope-cn | `qwen3.7-plus` | 最新 | 保留 |
| qwen-dashscope-cn | `qwen-max` | 可用非最新 | 老版稳定项,不要放旗舰区 |
| zai-glm | `glm-5.2` | 最新 | 保留 |
| zai-glm | `glm-5` | 可用非最新 | 保留为 fallback |
| zai-glm | `glm-4.6v` | 可用非最新 | 旧视觉项;优先换 GLM-5V/5.2 相关当前项 |
| zai-glm | `glm-4.7` | 可用非最新 | 旧通用项 |
| zai-glm | `glm-4.7-flash` | 可用非最新 | 旧高速项;仅作 fallback |
| volcengine-ark | `doubao-seed-1.6` | 过时/高风险 | 官方已出现 Seed 2.1;精确 API ID 需按方舟模型页/控制台二次确认 |
| volcengine-ark | `doubao-seed-1.6-thinking` | 过时/高风险 | 换 Seed 2.1 thinking/推理路线,需二次确认 exact ID |
| volcengine-ark | `doubao-seed-1.6-flash` | 过时/高风险 | 换 Seed 2.1 flash/高速路线,需二次确认 exact ID |
| volcengine-ark | `doubao-1.5-thinking-pro` | 过时/高风险 | 1.5 线不应作为精选 |
| volcengine-ark | `doubao-1.5-vision-pro` | 过时/高风险 | 1.5 线不应作为精选 |
| baidu-qianfan | `ernie-5.0` | 最新 | 保留,但 exact API ID 应按千帆“ERNIE-5.0 Preview”再核 |
| baidu-qianfan | `ernie-4.5-turbo-32k` | 可用非最新 | 4.5 系列不是最新旗舰 |
| baidu-qianfan | `ernie-4.5-8k` | 可用非最新 | 旧规格,不应作为精选靠前项 |
| baidu-qianfan | `ernie-x1-turbo-32k` | 可用非最新 | 可作为推理 fallback,但不是 5.0 旗舰 |
| baidu-qianfan | `ernie-speed-128k` | 可用非最新 | 长上下文/低成本 fallback |
| tencent-hunyuan | `hunyuan-turbos-latest` | 最新 | 保留 |
| tencent-hunyuan | `hunyuan-t1-latest` | 最新 | 保留 |
| tencent-hunyuan | `hunyuan-large` | 可用非最新 | 老通用项,优先换 T1/Turbo 新别名 |
| tencent-hunyuan | `hunyuan-vision` | 过时/高风险 | 当前文档使用 T1/Turbo vision 日期版,需换精确当前 ID |
| tencent-hunyuan | `hunyuan-standard` | 可用非最新 | 老标准项,不应放精选 |
| minimax | `MiniMax-M2.7` | 官方未确认 | models.dev/OpenRouter 有 `minimax-m2.7`;MiniMax 官方 API 文档未无凭据确认 |
| minimax | `MiniMax-M3` | 官方未确认 | models.dev/OpenRouter 有 `minimax-m3`;上线前需 MiniMax 官方/账号内 models 复核 |
| minimax | `MiniMax-M2.5` | 可用非最新 | 聚合源可见,不是最新 |
| minimax | `MiniMax-M2` | 可用非最新 | 旧版 |
| iflytek-spark | `4.0Ultra` | 可用非最新 | 文档显示 Ultra/Max 向 X1.5 升级;保留前需核 endpoint |
| iflytek-spark | `generalv3.5` | 过时/高风险 | 文档显示 Max 升级/迁移到 X1.5,不应作为精选 |
| iflytek-spark | `x1` | 过时/高风险 | 换 X1.5/Ultra X1.5 相关官方 ID |
| iflytek-spark | `pro-128k` | 可用非最新 | 长上下文 fallback |
| iflytek-spark | `lite` | 可用非最新 | 低成本 fallback |
| siliconflow-cn | `deepseek-ai/DeepSeek-V4-Pro` | 官方未确认 | 上游 DeepSeek 当前,但 SiliconFlow `/v1/models` 需 token,需账号内复核 |
| siliconflow-cn | `Qwen/Qwen3-Coder-480B-A35B-Instruct` | 官方未确认 | 上游 Qwen 当前,但 SiliconFlow exact ID 需账号内复核 |
| siliconflow-cn | `Pro/moonshotai/Kimi-K2.6` | 官方未确认 | 上游 Kimi 非最新;若保留应换 K2.7 路线并复核 exact ID |
| siliconflow-cn | `zai-org/GLM-5.2` | 官方未确认 | 上游 GLM 当前,但 SiliconFlow exact ID 需账号内复核 |
| siliconflow-cn | `deepseek-ai/DeepSeek-R1` | 官方未确认 | 上游 R1 不是当前 DeepSeek API 主推,建议换 V4/R1 当前托管项 |
| openai | `gpt-5.2` | 可用非最新 | 换广泛可用默认 `gpt-5.5`;`gpt-5.6` 仅标 trusted preview |
| openai | `gpt-5.2-codex` | 可用非最新 | 换 `gpt-5.3-codex` 或 `gpt-5-codex` |
| openai | `gpt-5-pro` | 可用非最新 | 换 `gpt-5.5-pro`;不要把 trusted preview 当默认 |
| openai | `o3` | 可用非最新 | 仅作推理 fallback,不要标“最新” |
| openai | `gpt-4o` | 可用非最新 | 旧多模态 fallback |
| openai | `gpt-4o-mini` | 可用非最新 | 旧轻量 fallback |
| openai | `gpt-image-1` | 过时/高风险 | 换 `gpt-image-2` |
| anthropic | `claude-opus-4-8` | 最新 | 保留 |
| anthropic | `claude-sonnet-5` | 最新 | 保留 |
| anthropic | `claude-sonnet-4-5` | 可用非最新 | 换 `claude-sonnet-5` 或保留为旧稳定项 |
| anthropic | `claude-haiku-4-5` | 最新 | 保留为轻量项 |
| anthropic | `claude-fable-5` | 最新 | 保留为创意项 |
| google | `gemini-3-pro-preview` | 过时/高风险 | Google 文档写 2026-04-29 shutdown;换 `gemini-3.1-pro-preview` 或当前稳定 `gemini-3.5-flash` |
| google | `gemini-3-flash-preview` | 可用非最新 | 换 `gemini-3.5-flash` |
| google | `gemini-2.5-pro` | 可用非最新 | 保留为稳定 fallback |
| google | `gemini-2.5-flash` | 可用非最新 | 保留为稳定 fallback |
| google | `gemini-2.5-flash-lite` | 可用非最新 | 保留为轻量 fallback |
| xai | `grok-4.3` | 最新 | 保留 |
| xai | `grok-4.20-0309-reasoning` | 过时/高风险 | 换官方 `grok-4.20`/`grok-4.3`,推理用请求参数控制 |
| xai | `grok-4.20-0309-non-reasoning` | 过时/高风险 | 换官方 `grok-4.20`/`grok-4.3`,非推理用请求参数控制 |
| groq | `llama-3.3-70b-versatile` | 最新 | 保留 |
| groq | `llama-3.1-8b-instant` | 可用非最新 | 老轻量项;优先换 `openai/gpt-oss-20b` 或 Llama 4 Scout |
| groq | `openai/gpt-oss-120b` | 最新 | 保留 |
| groq | `qwen/qwen3-32b` | 最新 | 保留 |
| groq | `groq/compound` | 最新 | 保留 |
| mistral | `mistral-large-latest` | 最新 | 保留,这是 alias |
| mistral | `mistral-medium-latest` | 最新 | 保留,这是 alias |
| mistral | `codestral-latest` | 最新 | 保留,这是 alias |
| mistral | `magistral-medium-latest` | 最新 | 保留 |
| mistral | `pixtral-large-latest` | 最新 | 保留 |
| mistral | `mistral-small-latest` | 最新 | 保留 |
| openrouter | `anthropic/claude-sonnet-4.5` | 可用非最新 | API 存在;换 `anthropic/claude-sonnet-5` |
| openrouter | `openai/gpt-5.2` | 可用非最新 | API 存在;OpenRouter 当前有 `openai/gpt-5.5`,OpenAI `gpt-5.6` 仅 trusted preview |
| openrouter | `google/gemini-2.5-pro` | 可用非最新 | API 存在;换 `google/gemini-3.5-flash` 或 `google/gemini-3.1-pro-preview` |
| openrouter | `deepseek/deepseek-chat` | 过时/高风险 | API 存在,但 DeepSeek 官方 chat/reasoner 退役计划影响它 |
| openrouter | `meta-llama/llama-3.3-70b-instruct` | 可用非最新 | API 存在;可留作开源 fallback |
| openrouter | `x-ai/grok-4.3` | 最新 | 保留 |
| perplexity | `sonar-pro` | 最新 | 保留 |
| perplexity | `sonar` | 最新 | 保留 |
| perplexity | `sonar-reasoning-pro` | 最新 | 保留 |
| perplexity | `sonar-deep-research` | 最新 | 保留 |
| ollama | `qwen2.5:7b` | 本地/自定义 | 不是云端最新;若用户本机有,可用;新默认建议换 `qwen3` |
| ollama | `deepseek-r1:7b` | 本地/自定义 | 取决于本机安装;不是 DeepSeek 云端当前 API |
| ollama | `qwen2.5vl:7b` | 本地/自定义 | 旧 VL 线;优先看本机是否有 Qwen3-VL |
| ollama | `qwen2.5:3b` | 本地/自定义 | 本地轻量 fallback |
| ollama | `qwen2.5:0.5b` | 本地/自定义 | 本地极小 fallback,不代表最新 |
| openai/local | `qwen2.5:7b` | 本地/自定义 | 同 Ollama,建议本机装 `qwen3` 后再设默认 |
| openai/local | `qwen2.5:3b` | 本地/自定义 | 本地轻量 fallback |
| openai/local | `local-model` | 本地/自定义 | 用户自填 |
| lmstudio | `qwen3` | 本地/自定义 | 可作为当前本地推荐,取决于 LM Studio 已下载模型 |
| lmstudio | `qwen3-coder` | 本地/自定义 | 可作为当前本地代码推荐 |
| lmstudio | `deepseek-r1` | 本地/自定义 | 旧/本地推理 fallback |
| lmstudio | `local-model` | 本地/自定义 | 用户自填 |
| custom-openai-compatible | `custom-model` | 本地/自定义 | 企业/自建网关占位,不做最新性判断 |

## 需要同步修的文件级问题

| 文件 | 问题 | 建议 |
|---|---|---|
| `apps/windows-client/ui/src/lib/model-highlights.ts` | 多个精选条目不是最新,且注释声称“最新 5-8 个” | 已改为“当前推荐 1-8 个”并替换核心高风险项;后续再加 modality/context 字段 |
| `apps/host/src/kimi/provider/catalog-data.ts` | 修复前默认/内置列表仍有 OpenAI `gpt-5.2`、Google preview、xAI `0309` ID、火山/百度老内置项 | 已修正 OpenAI/Anthropic/Google/xAI/OpenRouter/Kimi/本地默认与核心高风险内置项;火山/百度等需账号或官方 exact ID 二次复核 |
| `apps/host/src/kimi/provider/models-dev-catalog.ts` | `DEFAULT_MODEL_HINTS` 里有 `gpt-5.2`、`gemini-3-pro-preview`、`grok-4.20-0309-reasoning`、`claude-sonnet-4-5` | 已改成当前 hint,并新增 Kimi/DeepSeek/Google/xAI/OpenAI exclude |
| `apps/windows-client/ui/src/components/SettingsTabsContent.tsx` / `Composer.tsx` | 修复前 fallback provider 仍以 `qwen2.5` 本地模型为默认 | 已把本地 fallback 默认改为 `qwen3`,保留 `qwen2.5` 作为手动 fallback |
| `reports/HANDOFF-20260705-ui-models.md` | 第五节声称 models.dev 已查好且“别再重查” | 已不可信,应引用本报告并禁止按旧表直接填 |

## 当前来源验证

- 本地代码: `Get-Content -Raw apps/windows-client/ui/src/lib/model-highlights.ts`;`Get-Content -Raw apps/host/src/kimi/provider/catalog-data.ts`;`Get-Content -Raw apps/host/src/kimi/provider/models-dev-catalog.ts`;`Get-Content -Raw apps/windows-client/ui/src/components/SettingsTabsContent.tsx`;`rg "gpt-5\\.2|gemini-3-pro-preview|grok-4\\.20|kimi-k2|deepseek-v4|doubao-seed|qwen3\\.7|MiniMax-M2|claude-opus-4-8|sonar-deep-research"`。
- OpenAI 官方模型页: https://platform.openai.com/docs/models ,2026-07-05 查询,显示 GPT-5.6 为 trusted preview;本次广泛默认使用 `gpt-5.5`/`gpt-5.5-pro`,图像生成换 `gpt-image-2`。
- Anthropic 官方模型页: https://docs.anthropic.com/en/docs/about-claude/models/overview ,2026-07-05 查询。
- Google Gemini 官方模型页: https://ai.google.dev/gemini-api/docs/models ,2026-07-05 查询,显示 Gemini 3.5 Flash、Gemini 3.1 Pro Preview,并把 Gemini 3 Pro Preview 列为 Previous/shutdown。
- DeepSeek 官方价格/模型页: https://api-docs.deepseek.com/quick_start/pricing ,2026-07-05 查询,显示 chat/reasoner 退役日期 2026-07-24。
- Moonshot/Kimi 官方文档: https://platform.moonshot.ai/docs/guide/start-using-kimi-api ,2026-07-05 查询,显示 K2.7 Code、K2.6/K2.5,并标出 deprecated K2 thinking/turbo preview。
- 阿里云百炼模型页: https://help.aliyun.com/zh/model-studio/getting-started/models ,2026-07-05 查询,显示 Qwen3.7、Qwen3-Coder、Qwen3-VL 等当前模型。
- Z.ai 官方模型文档: https://docs.z.ai/guides/llm/glm-4.6 ,2026-07-05 查询,导航显示 GLM-5.2/5.1/5V 等当前模型族。
- 火山方舟官方模型页: https://www.volcengine.com/docs/82379/1330310 ,2026-07-05 查询,导航显示 Seed 2.1。
- 百度千帆官方模型服务页: https://cloud.baidu.com/doc/qianfan/s/rmh4stp0j ,2026-07-05 查询。
- 腾讯混元官方 API 文档: https://cloud.tencent.com/document/product/1729/104753 ,2026-07-05 查询。
- 讯飞星火官方 Web API 文档: https://www.xfyun.cn/doc/spark/Web.html ,2026-07-05 查询,显示 Ultra X1.5/Max 升级信息。
- xAI 官方模型页: https://docs.x.ai/docs/models ,2026-07-05 查询,显示 Grok 4.3 / 4.2 / 4.1 系列。
- Groq 官方模型页: https://console.groq.com/docs/models ,2026-07-05 查询。
- Mistral 官方模型页: https://docs.mistral.ai/getting-started/models/models_overview/ ,2026-07-05 查询。
- Perplexity 官方 Model Cards: https://docs.perplexity.ai/guides/model-cards ,2026-07-05 查询。
- Ollama 官方 qwen3 页面: https://ollama.com/library/qwen3 ,2026-07-05 查询。
- OpenRouter 公开模型 API: `Invoke-WebRequest -Uri https://openrouter.ai/api/v1/models -OutFile C:\tmp\openrouter-models-20260705.json`;Node 解析确认 340 个模型,其中 `google/gemini-3-pro-preview=false`,`google/gemini-3.5-flash=true`,`anthropic/claude-opus-4.8=true`,`anthropic/claude-sonnet-5=true`,`x-ai/grok-4.20=true`,`x-ai/grok-4.3=true`。
- models.dev 聚合源: `C:\tmp\models-dev-api-20260705.json`,2026-07-05 11:19 本机下载,151 providers/2703 model ids。仅作为聚合对照,不替代官方文档。
- SiliconFlow 官方 API 边界: `Invoke-WebRequest -Uri https://api.siliconflow.cn/v1/models` 返回 `"Invalid token"`,未用真实凭据,因此 exact ID 标为官方未确认。
