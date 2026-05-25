import { useEffect, useMemo, useState } from 'react';
import { getJson, getOnboardingRecommendations } from '../lib/api';
import {
  getFallbackOnboarding,
  selectRecommendedDependencies,
  selectInitialRole,
  toOnboardingViewModel,
  type OnboardingResponse,
  type OnboardingRole,
  type OnboardingViewModel,
  type RuntimeDependencyItem,
} from '../lib/onboarding';

interface RuntimeDependencyStatus {
  dependencies?: RuntimeDependencyItem[];
}

interface OnboardingPanelProps {
  workspaceType?: string;
  onComplete: () => void;
  onOpenSettings: () => void;
}

export function OnboardingPanel({ workspaceType = 'local', onComplete, onOpenSettings }: OnboardingPanelProps) {
  const [role, setRole] = useState<OnboardingRole>(() => selectInitialRole());
  const [response, setResponse] = useState<OnboardingResponse>(() => getFallbackOnboarding(role, workspaceType));
  const [loading, setLoading] = useState(false);
  const [usingFallback, setUsingFallback] = useState(false);
  const [dependencyStatus, setDependencyStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [dependencies, setDependencies] = useState<RuntimeDependencyItem[]>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getOnboardingRecommendations({ role, workspaceType })
      .then((next) => {
        if (cancelled) return;
        setResponse(next);
        setUsingFallback(false);
      })
      .catch(() => {
        if (cancelled) return;
        setResponse(getFallbackOnboarding(role, workspaceType));
        setUsingFallback(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [role, workspaceType]);

  const viewModel: OnboardingViewModel = useMemo(() => toOnboardingViewModel(response), [response]);

  useEffect(() => {
    if (viewModel.dependencyCheck.route !== '/api/runtime/dependencies') return;
    let cancelled = false;
    setDependencyStatus('loading');
    getJson<RuntimeDependencyStatus>(viewModel.dependencyCheck.route)
      .then((status) => {
        if (cancelled) return;
        setDependencies(selectRecommendedDependencies(status.dependencies || [], viewModel.dependencyCheck.recommendedIds));
        setDependencyStatus('ready');
      })
      .catch(() => {
        if (!cancelled) setDependencyStatus('failed');
      });
    return () => { cancelled = true; };
  }, [viewModel.dependencyCheck.route, viewModel.dependencyCheck.recommendedIds]);

  const pickRole = (nextRole: OnboardingRole) => {
    setRole(nextRole);
    setResponse(getFallbackOnboarding(nextRole, workspaceType));
  };

  return (
    <aside className="onboarding-panel" aria-label="首启引导">
      <div className="onboarding-head">
        <div>
          <h2>先按你的工作方式配一下</h2>
          <p>{loading ? '正在读取推荐…' : usingFallback ? '当前使用本地推荐，稍后可在设置中调整。' : '这些只是初始建议，不影响你继续使用主界面。'}</p>
        </div>
        <button type="button" className="onboarding-close" aria-label="关闭首启引导" onClick={onComplete}>×</button>
      </div>

      <div className="onboarding-roles" role="list" aria-label="选择角色">
        {viewModel.roleOptions.map((option) => (
          <button
            type="button"
            key={option.id}
            className={option.id === viewModel.selectedRole ? 'is-active' : ''}
            aria-pressed={option.id === viewModel.selectedRole}
            onClick={() => pickRole(option.id)}
          >
            <strong>{option.label}</strong>
            <span>{option.description}</span>
          </button>
        ))}
      </div>

      <section className="onboarding-dependency">
        <strong>依赖体检</strong>
        <span>{dependencyStatus === 'loading' ? '正在读取依赖状态…' : dependencyStatus === 'ready' ? '已读取当前推荐组件状态。' : viewModel.dependencySummary}</span>
        {dependencies.length > 0 && (
          <div className="onboarding-dependency-list">
            {dependencies.slice(0, 6).map((item) => (
              <span key={item.id} data-status={item.status}>{item.label}: {item.status}</span>
            ))}
          </div>
        )}
      </section>

      <div className="onboarding-sections">
        {viewModel.recommendationSections.map((section) => (
          <section key={section.id} className="onboarding-section">
            <h3>{section.title}</h3>
            <ul>
              {section.items.map((item) => (
                <li key={item.id}>
                  <strong>{item.label}</strong>
                  <span>{item.reason}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      <div className="onboarding-actions">
        <button type="button" className="btn-secondary" onClick={onComplete}>稍后再说</button>
        <button type="button" className="btn-secondary" onClick={onComplete}>完成</button>
        <button type="button" className="btn-primary" onClick={onOpenSettings}>进入设置</button>
      </div>
    </aside>
  );
}
