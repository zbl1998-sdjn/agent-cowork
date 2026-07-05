// 模型精选表(UI · lib):每厂商展示「当前推荐 1-8 个」代表模型,按业界通用能力维度打标签 + 一句话特点,
// 让用户不用背 model id 也能快速判断「这个模型擅长什么、要不要用」。
// ---------------------------------------------------------------------------
// 后端 catalog 仍返回该厂商全量模型(可在输入框手输任意 id);此表只决定「下拉里默认展示哪几个 + 怎么标注」。
// model id 取自官方文档/API、models.dev 与 OpenRouter 当前查询;tags/note 为人工标注。

// 标准能力标签(展示为彩色 chip);语义色见前端 CSS。
export type ModelTag =
  | '旗舰' | '平衡' | '轻量' | '免费'
  | '推理' | '代码' | '多模态' | '视觉' | '长上下文' | '高速' | 'Agent' | '联网搜索' | '创意' | '聚合' | '本地';

export interface ModelHighlight {
  id: string;
  modality: '语言' | '多模态';
  context: string;
  tags: ModelTag[];
  note: string;
}

type BaseModelHighlight = Omit<ModelHighlight, 'modality' | 'context'>;
type ModelMetadata = Pick<ModelHighlight, 'modality' | 'context'>;

// 按 provider id 组织;每组 1-8 个,旗舰/当前推荐在前。
const BASE_MODEL_HIGHLIGHTS: Record<string, BaseModelHighlight[]> = {
  'kimi-api': [
    { id: 'kimi-k2.7-code', tags: ['旗舰', '代码', 'Agent'], note: '编码与工具调用最强,Agent 首选' },
    { id: 'kimi-k2.7-code-highspeed', tags: ['代码', '高速'], note: 'K2.7 高速代码路线' },
    { id: 'kimi-k2.6', tags: ['平衡'], note: '日常通用对话' },
    { id: 'kimi-k2.5', tags: ['平衡'], note: '上一代通用,稳定' },
  ],
  deepseek: [
    { id: 'deepseek-v4-pro', tags: ['旗舰'], note: '综合最强,复杂任务' },
    { id: 'deepseek-v4-flash', tags: ['高速', '轻量'], note: '快且省,日常够用' },
  ],
  'qwen-dashscope-cn': [
    { id: 'qwen3-max', tags: ['旗舰'], note: '通用最强' },
    { id: 'qwen3.7-max', tags: ['旗舰'], note: '最新旗舰' },
    { id: 'qwen3-coder-plus', tags: ['代码'], note: '代码专用,补全/重构' },
    { id: 'qwen3-vl-plus', tags: ['多模态', '视觉'], note: '图像/文档理解' },
    { id: 'qwen3.7-plus', tags: ['平衡'], note: '性价比通用' },
    { id: 'qwen-max', tags: ['平衡'], note: '稳定旗舰,老版' },
  ],
  'zai-glm': [
    { id: 'glm-5.2', tags: ['旗舰'], note: '最新旗舰,通用强' },
    { id: 'glm-5', tags: ['平衡'], note: '通用主力' },
    { id: 'glm-4.6v', tags: ['多模态', '视觉'], note: '图像理解' },
    { id: 'glm-4.7', tags: ['平衡'], note: '通用' },
    { id: 'glm-4.7-flash', tags: ['高速', '免费'], note: '免费高速' },
  ],
  'volcengine-ark': [
    { id: 'doubao-seed-1.6', tags: ['旗舰', '多模态'], note: '豆包旗舰,图文' },
    { id: 'doubao-seed-1.6-thinking', tags: ['推理'], note: '深度思考' },
    { id: 'doubao-seed-1.6-flash', tags: ['高速', '多模态'], note: '高速图文' },  ],
  'baidu-qianfan': [
    { id: 'ernie-5.0', tags: ['旗舰', '多模态'], note: '文心 5.0,全模态旗舰' },
    { id: 'ernie-4.5-turbo-32k', tags: ['多模态', '高速'], note: '图文高速' },
    { id: 'ernie-4.5-8k', tags: ['多模态'], note: '图文通用' },
    { id: 'ernie-x1-turbo-32k', tags: ['推理'], note: '深度思考(X1)' },
    { id: 'ernie-speed-128k', tags: ['高速', '长上下文'], note: '长文高速' },
  ],
  'tencent-hunyuan': [
    { id: 'hunyuan-turbos-latest', tags: ['旗舰'], note: '混元最新旗舰' },
    { id: 'hunyuan-t1-latest', tags: ['推理'], note: '深度推理(T1)' },
    { id: 'hunyuan-large', tags: ['平衡'], note: '大参数通用' },
    { id: 'hunyuan-vision', tags: ['视觉'], note: '视觉理解' },
    { id: 'hunyuan-standard', tags: ['长上下文'], note: '长文标准版' },
  ],
  minimax: [
    { id: 'MiniMax-M2.7', tags: ['旗舰'], note: '最新旗舰' },
    { id: 'MiniMax-M3', tags: ['平衡'], note: '新一代通用' },
    { id: 'MiniMax-M2.5', tags: ['平衡'], note: '通用' },
    { id: 'MiniMax-M2', tags: ['平衡'], note: '上一代' },
  ],
  'iflytek-spark': [
    { id: '4.0Ultra', tags: ['旗舰'], note: '星火 4.0 Ultra' },    { id: 'x1', tags: ['推理'], note: '深度推理(X1)' },
    { id: 'pro-128k', tags: ['长上下文'], note: '长文 Pro' },
    { id: 'lite', tags: ['轻量', '高速'], note: '轻量高速' },
  ],
  'siliconflow-cn': [
    { id: 'deepseek-ai/DeepSeek-V4-Pro', tags: ['聚合', '旗舰'], note: '托管 DeepSeek 旗舰' },
    { id: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', tags: ['聚合', '代码'], note: '托管通义代码' },
    { id: 'Pro/moonshotai/Kimi-K2.6', tags: ['聚合'], note: '托管 Kimi' },
    { id: 'zai-org/GLM-5.2', tags: ['聚合', '旗舰'], note: '托管 GLM 旗舰' },
  ],
  openai: [
    { id: 'gpt-5.5', tags: ['旗舰', '推理'], note: '广泛可用主力旗舰' },
    { id: 'gpt-5.5-pro', tags: ['推理'], note: '高强度推理与复杂任务' },
    { id: 'gpt-5.3-codex', tags: ['代码', 'Agent'], note: '编程/Agent 任务优化' },
    { id: 'o3', tags: ['推理'], note: 'o 系列推理' },
    { id: 'gpt-4o', tags: ['多模态', '高速'], note: '图文语音,日常快' },
    { id: 'gpt-4o-mini', tags: ['多模态', '轻量'], note: '便宜快速' },
    { id: 'gpt-image-2', tags: ['多模态'], note: '图像生成' },
  ],
  anthropic: [
    { id: 'claude-opus-4-8', tags: ['旗舰', '代码', 'Agent'], note: '编码与 Agent 最强' },
    { id: 'claude-sonnet-5', tags: ['平衡'], note: '新一代平衡主力' },
    { id: 'claude-sonnet-4-5', tags: ['代码'], note: '编码强,性价比' },
    { id: 'claude-haiku-4-5', tags: ['轻量', '高速'], note: '轻快便宜' },
    { id: 'claude-fable-5', tags: ['创意'], note: '创意写作' },
  ],
  google: [
    { id: 'gemini-3.5-flash', tags: ['旗舰', '多模态', '高速'], note: '当前高速多模态主力' },
    { id: 'gemini-3.1-pro-preview', tags: ['旗舰', '多模态', '长上下文'], note: '长上下文复杂任务' },
    { id: 'gemini-3-flash-preview', tags: ['多模态', '高速'], note: '高速多模态' },
    { id: 'gemini-2.5-pro', tags: ['多模态', '长上下文'], note: '长上下文主力' },
    { id: 'gemini-2.5-flash', tags: ['多模态', '高速'], note: '高速性价比' },
    { id: 'gemini-2.5-flash-lite', tags: ['多模态', '轻量'], note: '最便宜' },
  ],
  xai: [
    { id: 'grok-4.3', tags: ['旗舰'], note: '最新旗舰' },
    { id: 'grok-build-0.1', tags: ['代码', 'Agent'], note: 'xAI Coding Agent 路线' },
  ],
  groq: [
    { id: 'llama-3.3-70b-versatile', tags: ['高速'], note: '超快推理,通用' },
    { id: 'llama-3.1-8b-instant', tags: ['高速', '轻量'], note: '极速轻量' },
    { id: 'openai/gpt-oss-120b', tags: ['旗舰'], note: '开源大模型' },
    { id: 'qwen/qwen3-32b', tags: ['平衡'], note: '通义开源' },
    { id: 'groq/compound', tags: ['Agent'], note: '带工具编排' },
  ],
  mistral: [
    { id: 'mistral-large-latest', tags: ['旗舰'], note: '通用旗舰' },
    { id: 'mistral-medium-latest', tags: ['平衡'], note: '平衡' },
    { id: 'codestral-latest', tags: ['代码'], note: '代码专用' },
    { id: 'magistral-medium-latest', tags: ['推理'], note: '深度推理' },
    { id: 'pixtral-large-latest', tags: ['多模态', '视觉'], note: '视觉理解' },
    { id: 'mistral-small-latest', tags: ['轻量'], note: '轻量便宜' },
  ],
  openrouter: [
    { id: 'anthropic/claude-sonnet-5', tags: ['聚合', '代码'], note: '路由到 Claude Sonnet' },
    { id: 'anthropic/claude-opus-4.8', tags: ['聚合', '旗舰'], note: '路由到 Claude Opus' },
    { id: 'openai/gpt-5.5', tags: ['聚合', '旗舰'], note: '路由到 GPT' },
    { id: 'google/gemini-3.5-flash', tags: ['聚合', '多模态'], note: '路由到 Gemini' },
    { id: 'google/gemini-3.1-pro-preview', tags: ['聚合', '多模态'], note: 'Gemini 长上下文' },
    { id: 'deepseek/deepseek-v4-pro', tags: ['聚合'], note: '路由到 DeepSeek V4' },
    { id: 'meta-llama/llama-3.3-70b-instruct', tags: ['聚合'], note: '路由到 Llama' },
    { id: 'x-ai/grok-4.3', tags: ['聚合'], note: '路由到 Grok' },
  ],
  perplexity: [
    { id: 'sonar-pro', tags: ['联网搜索'], note: '实时联网,带引用' },
    { id: 'sonar', tags: ['联网搜索', '轻量'], note: '联网搜索,便宜' },
    { id: 'sonar-reasoning-pro', tags: ['联网搜索', '推理'], note: '推理 + 搜索' },
    { id: 'sonar-deep-research', tags: ['联网搜索'], note: '深度研究报告' },
  ],
  ollama: [
    { id: 'qwen3', tags: ['本地'], note: '本地通义当前主力' },
    { id: 'qwen3-coder', tags: ['本地', '代码'], note: '本地代码模型' },
    { id: 'qwen2.5:7b', tags: ['本地'], note: '本地通义 7B' },
    { id: 'qwen2.5vl:7b', tags: ['本地', '视觉'], note: '本地视觉' },
    { id: 'qwen2.5:3b', tags: ['本地', '轻量'], note: '本地轻量' },
    { id: 'qwen2.5:0.5b', tags: ['本地', '轻量'], note: '低成本 smoke / 低配机器' },
  ],
  'openai/local': [
    { id: 'qwen3', tags: ['本地'], note: '本地 OpenAI 兼容' },
    { id: 'qwen3-coder', tags: ['本地', '代码'], note: '本地代码模型' },
    { id: 'qwen2.5:7b', tags: ['本地'], note: '本地 OpenAI 兼容' },
    { id: 'qwen2.5:3b', tags: ['本地', '轻量'], note: '本地轻量' },
    { id: 'qwen2.5:0.5b', tags: ['本地', '轻量'], note: '低成本 smoke / 低配机器' },
    { id: 'local-model', tags: ['本地'], note: '自定义本地模型' },
  ],
  lmstudio: [
    { id: 'qwen3', tags: ['本地'], note: 'LM Studio 通义' },
    { id: 'qwen3-coder', tags: ['本地', '代码'], note: 'LM Studio 代码' },
    { id: 'gpt-oss-20b', tags: ['本地'], note: 'LM Studio 开源通用' },
    { id: 'local-model', tags: ['本地'], note: '自定义本地模型' },
  ],
  'custom-openai-compatible': [
    { id: 'custom-model', tags: ['本地'], note: '自定义网关模型' },
  ],
};
const MODEL_METADATA: Record<string, ModelMetadata> = {
  'kimi-k2.7-code': { modality: '多模态', context: '256K' },
  'kimi-k2.7-code-highspeed': { modality: '多模态', context: '256K' },
  'kimi-k2.6': { modality: '多模态', context: '256K' },
  'kimi-k2.5': { modality: '多模态', context: '256K' },
  'deepseek-v4-pro': { modality: '语言', context: '1M' },
  'deepseek-v4-flash': { modality: '语言', context: '1M' },
  'qwen3-max': { modality: '语言', context: '256K' },
  'qwen3.7-max': { modality: '语言', context: '1M' },
  'qwen3-coder-plus': { modality: '语言', context: '1M' },
  'qwen3-vl-plus': { modality: '多模态', context: '256K' },
  'qwen3.7-plus': { modality: '多模态', context: '1M' },
  'qwen-max': { modality: '语言', context: '128K' },
  'glm-5.2': { modality: '语言', context: '1M' },
  'glm-5': { modality: '语言', context: '200K' },
  'glm-4.6v': { modality: '多模态', context: '128K' },
  'glm-4.7': { modality: '语言', context: '200K' },
  'glm-4.7-flash': { modality: '语言', context: '200K' },
  'doubao-seed-1.6': { modality: '多模态', context: '256K' },
  'doubao-seed-1.6-thinking': { modality: '语言', context: '256K' },
  'doubao-seed-1.6-flash': { modality: '多模态', context: '256K' },  'ernie-5.0': { modality: '多模态', context: '长上下文' },
  'ernie-4.5-turbo-32k': { modality: '多模态', context: '32K' },
  'ernie-4.5-8k': { modality: '多模态', context: '8K' },
  'ernie-x1-turbo-32k': { modality: '语言', context: '32K' },
  'ernie-speed-128k': { modality: '语言', context: '128K' },
  'hunyuan-turbos-latest': { modality: '语言', context: '256K' },
  'hunyuan-t1-latest': { modality: '语言', context: '256K' },
  'hunyuan-large': { modality: '语言', context: '256K' },
  'hunyuan-vision': { modality: '多模态', context: '256K' },
  'hunyuan-standard': { modality: '语言', context: '256K' },
  'MiniMax-M2.7': { modality: '语言', context: '205K' },
  'MiniMax-M3': { modality: '多模态', context: '1M' },
  'MiniMax-M2.5': { modality: '语言', context: '205K' },
  'MiniMax-M2': { modality: '语言', context: '197K' },
  '4.0Ultra': { modality: '语言', context: '8K-128K' },  'x1': { modality: '语言', context: '8K-128K' },
  'pro-128k': { modality: '语言', context: '128K' },
  'lite': { modality: '语言', context: '8K' },
  'deepseek-ai/DeepSeek-V4-Pro': { modality: '语言', context: '1M' },
  'Qwen/Qwen3-Coder-480B-A35B-Instruct': { modality: '语言', context: '1M' },
  'Pro/moonshotai/Kimi-K2.6': { modality: '多模态', context: '256K' },
  'zai-org/GLM-5.2': { modality: '语言', context: '1M' },
  'gpt-5.5': { modality: '多模态', context: '400K' },
  'gpt-5.5-pro': { modality: '多模态', context: '400K' },
  'gpt-5.3-codex': { modality: '语言', context: '400K' },
  'o3': { modality: '多模态', context: '200K' },
  'gpt-4o': { modality: '多模态', context: '128K' },
  'gpt-4o-mini': { modality: '多模态', context: '128K' },
  'gpt-image-2': { modality: '多模态', context: '图像生成' },
  'claude-opus-4-8': { modality: '多模态', context: '1M' },
  'claude-sonnet-5': { modality: '多模态', context: '1M' },
  'claude-sonnet-4-5': { modality: '多模态', context: '200K' },
  'claude-haiku-4-5': { modality: '多模态', context: '200K' },
  'claude-fable-5': { modality: '多模态', context: '1M' },
  'gemini-3.5-flash': { modality: '多模态', context: '1M' },
  'gemini-3.1-pro-preview': { modality: '多模态', context: '1M' },
  'gemini-3-flash-preview': { modality: '多模态', context: '1M' },
  'gemini-2.5-pro': { modality: '多模态', context: '1M' },
  'gemini-2.5-flash': { modality: '多模态', context: '1M' },
  'gemini-2.5-flash-lite': { modality: '多模态', context: '1M' },
  'grok-4.3': { modality: '多模态', context: '1M' },
  'grok-build-0.1': { modality: '语言', context: '256K' },
  'llama-3.3-70b-versatile': { modality: '语言', context: '128K' },
  'llama-3.1-8b-instant': { modality: '语言', context: '128K' },
  'openai/gpt-oss-120b': { modality: '语言', context: '128K' },
  'qwen/qwen3-32b': { modality: '语言', context: '128K' },
  'groq/compound': { modality: '语言', context: '128K' },
  'mistral-large-latest': { modality: '多模态', context: '256K' },
  'mistral-medium-latest': { modality: '多模态', context: '256K' },
  'codestral-latest': { modality: '语言', context: '256K' },
  'magistral-medium-latest': { modality: '语言', context: '128K' },
  'pixtral-large-latest': { modality: '多模态', context: '128K' },
  'mistral-small-latest': { modality: '多模态', context: '256K' },
  'anthropic/claude-sonnet-5': { modality: '多模态', context: '1M' },
  'anthropic/claude-opus-4.8': { modality: '多模态', context: '1M' },
  'openai/gpt-5.5': { modality: '多模态', context: '400K' },
  'google/gemini-3.5-flash': { modality: '多模态', context: '1M' },
  'google/gemini-3.1-pro-preview': { modality: '多模态', context: '1M' },
  'deepseek/deepseek-v4-pro': { modality: '语言', context: '1M' },
  'meta-llama/llama-3.3-70b-instruct': { modality: '语言', context: '128K' },
  'x-ai/grok-4.3': { modality: '多模态', context: '1M' },
  'sonar-pro': { modality: '多模态', context: '200K' },
  'sonar': { modality: '语言', context: '128K' },
  'sonar-reasoning-pro': { modality: '多模态', context: '128K' },
  'sonar-deep-research': { modality: '语言', context: '128K' },
  'qwen3': { modality: '语言', context: '本机配置' },
  'qwen3-coder': { modality: '语言', context: '本机配置' },
  'qwen2.5:7b': { modality: '语言', context: '本机配置' },
  'qwen2.5vl:7b': { modality: '多模态', context: '本机配置' },
  'qwen2.5:3b': { modality: '语言', context: '本机配置' },
  'qwen2.5:0.5b': { modality: '语言', context: '本机配置' },
  'local-model': { modality: '语言', context: '本机配置' },
  'gpt-oss-20b': { modality: '语言', context: '本机配置' },
  'custom-model': { modality: '语言', context: '自定义' },
};

function metadataFor(providerId: string, model: BaseModelHighlight): ModelMetadata {
  const providerScoped = MODEL_METADATA[`${providerId}:${model.id}`];
  if (providerScoped) return providerScoped;
  const byId = MODEL_METADATA[model.id];
  if (byId) return byId;
  return {
    modality: model.tags.includes('多模态') || model.tags.includes('视觉') ? '多模态' : '语言',
    context: model.tags.includes('本地') ? '本机配置' : '待确认',
  };
}

export const MODEL_HIGHLIGHTS: Record<string, ModelHighlight[]> = Object.fromEntries(
  Object.entries(BASE_MODEL_HIGHLIGHTS).map(([providerId, models]) => [
    providerId,
    models.map((model) => ({ ...model, ...metadataFor(providerId, model) })),
  ]),
) as Record<string, ModelHighlight[]>;

// 取某 provider 的精选;缺省回退到该 provider 的全量前 8 个(无标签)。
export function highlightsForProvider(providerId: string, fallbackModels: readonly string[] = []): ModelHighlight[] {
  const curated = MODEL_HIGHLIGHTS[providerId];
  if (curated && curated.length) return curated;
  return fallbackModels.slice(0, 8).map((id) => ({ id, modality: '语言', context: '自定义', tags: [] as ModelTag[], note: '' }));
}
