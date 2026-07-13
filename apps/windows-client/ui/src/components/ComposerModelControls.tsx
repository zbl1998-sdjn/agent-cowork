// ComposerModelControls(UI · components):输入框模型控制——选择提供商 + 从「精选模型」里挑(带能力标签/特点),
// 也可手输任意 model id(后端仍支持全量)。纯展示 + 回调 + 一个本地开合状态。
import { useState } from 'react';
import type { ModelProviderOption } from '../lib/api/kimiConfig';
import { highlightsForProvider, type ModelTag } from '../lib/model-highlights';

const FALLBACK_PROVIDER_OPTIONS = [
  { id: 'kimi-api', displayName: 'Kimi / Moonshot' },
  { id: 'deepseek', displayName: 'DeepSeek' },
  { id: 'qwen-dashscope-cn', displayName: 'Qwen / DashScope' },
  { id: 'zai-glm', displayName: 'Z.ai / GLM' },
  { id: 'openai', displayName: 'OpenAI' },
  { id: 'anthropic', displayName: 'Anthropic Claude' },
  { id: 'google', displayName: 'Google Gemini' },
  { id: 'xai', displayName: 'xAI Grok' },
  { id: 'groq', displayName: 'Groq' },
  { id: 'mistral', displayName: 'Mistral' },
  { id: 'openrouter', displayName: 'OpenRouter' },
  { id: 'perplexity', displayName: 'Perplexity' },
  { id: 'ollama', displayName: 'Ollama' },
  { id: 'openai/local', displayName: '本地 OpenAI-compatible' },
  { id: 'lmstudio', displayName: 'LM Studio' },
];

export function modelProviderDisplayName(provider: string, providerOptions?: ModelProviderOption[]): string {
  const options = providerOptions?.length ? providerOptions : FALLBACK_PROVIDER_OPTIONS;
  return options.find((item) => item.id === provider)?.displayName || provider || '默认模型';
}

function providerRuntimeLabel(item: Pick<ModelProviderOption, 'displayName' | 'runtimeState'>): string {
  const state = item.runtimeState;
  if (!state || state.enabled) return item.displayName;
  if (!state.configured) return `${item.displayName}（未配置）`;
  if (state.policyDecision !== 'allow') return `${item.displayName}（受安全策略限制）`;
  return `${item.displayName}（当前不可用）`;
}

// 标签 → 语义 class(颜色见 CSS)
const TAG_CLASS: Record<ModelTag, string> = {
  '旗舰': 'flagship', '平衡': 'balance', '轻量': 'light', '免费': 'free',
  '推理': 'reason', '代码': 'code', '多模态': 'vision', '视觉': 'vision',
  '长上下文': 'long', '高速': 'fast', 'Agent': 'agent', '联网搜索': 'search',
  '创意': 'creative', '聚合': 'hub', '本地': 'local',
};

interface ComposerModelControlsProps {
  model: string;
  modelOptions: string[];
  providerOptions?: ModelProviderOption[] | undefined;
  provider: string;
  defaultModel: string;
  onProvider: (value: string) => void;
  onModel: (value: string) => void;
}

// 本轮提供商 + 模型选择器。Base URL / API Key 故意不在此处——那属于凭据,应放在设置(⚙)里。
export function ComposerModelControls({
  model, modelOptions, providerOptions, provider, defaultModel,
  onProvider, onModel,
}: ComposerModelControlsProps) {
  const [open, setOpen] = useState(false);
  const options = (providerOptions?.length ? providerOptions : FALLBACK_PROVIDER_OPTIONS)
    .map((item) => ({
      id: item.id,
      displayName: providerRuntimeLabel(item as ModelProviderOption),
      disabled: Boolean((item as ModelProviderOption).runtimeState && !(item as ModelProviderOption).runtimeState?.enabled),
    }));
  if (provider && !options.some((item) => item.id === provider)) {
    options.unshift({ id: provider, displayName: provider, disabled: false });
  }
  const highlights = highlightsForProvider(provider, modelOptions);

  return (
    <>
      <select className="provider-select" value={provider} onChange={(e) => onProvider(e.target.value)} title="本轮模型提供商">
        {options.map((opt) => <option key={opt.id} value={opt.id} disabled={opt.disabled}>{opt.displayName}</option>)}
      </select>
      <div className="model-picker">
        <input
          className="model-input"
          value={model}
          onChange={(e) => onModel(e.target.value)}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 160)}
          placeholder={defaultModel || '模型'}
          title="本轮模型(可从下方精选里挑,或手输任意 model id)"
          aria-label="本轮模型"
        />
        {open && highlights.length > 0 && (
          <div className="model-menu" role="listbox" aria-label="精选模型">
            <div className="model-menu-head">精选 · 可手输任意模型</div>
            {highlights.map((h) => (
              <button
                key={h.id}
                type="button"
                className={`model-opt${h.id === model ? ' is-active' : ''}`}
                onMouseDown={(e) => { e.preventDefault(); onModel(h.id); setOpen(false); }}
              >
                <span className="model-opt-id">{h.id}</span>
                <span className="model-opt-meta">{h.modality} · {h.context}</span>
                {h.tags.length > 0 && (
                  <span className="model-opt-tags">
                    {h.tags.map((t) => <span key={t} className={`model-tag tag-${TAG_CLASS[t]}`}>{t}</span>)}
                  </span>
                )}
                {h.note && <span className="model-opt-note">{h.note}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}
