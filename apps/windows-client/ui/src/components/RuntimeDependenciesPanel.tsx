import { useEffect, useMemo, useState } from 'react';
import {
  getRuntimeDependencies,
  getRuntimeDependencyInstallPlan,
  type RuntimeDependencyInstallPlanResponse,
  type RuntimeDependencyResponse,
} from '../lib/api';
import {
  toRuntimeDependencyInstallPlanViewModel,
  toRuntimeDependencyViewModel,
  type RuntimeDependencyInstallPlanViewModel,
  type RuntimeDependencyViewModel,
} from '../lib/runtime-dependencies';

export function RuntimeDependencyInstallPlanPreview({ plan }: { plan: RuntimeDependencyInstallPlanViewModel }) {
  return (
    <section className={`runtime-install-plan runtime-install-plan-${plan.diskSeverity}`} aria-label="安装计划预检">
      <div className="runtime-install-plan-head">
        <strong>{plan.title}</strong>
        <span>{plan.componentCount} 个组件</span>
      </div>
      <p>{plan.diskMessage}</p>
      <div className="runtime-install-plan-meta">
        <span>预计下载 {plan.requiredBytesLabel}</span>
        <span>缺口 {plan.missingBytesLabel}</span>
      </div>
      {plan.componentLabels.length > 0 && (
        <ul>
          {plan.componentLabels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      )}
      {plan.unknownIds.length > 0 && (
        <p className="runtime-install-plan-unknown">未知组件：{plan.unknownIds.join('、')}</p>
      )}
    </section>
  );
}

export function RuntimeDependenciesPanel() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [data, setData] = useState<RuntimeDependencyResponse | null>(null);
  const [error, setError] = useState('');
  const [planStatus, setPlanStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [installPlan, setInstallPlan] = useState<RuntimeDependencyInstallPlanResponse | null>(null);
  const [planError, setPlanError] = useState('');

  const load = () => {
    setStatus('loading');
    setError('');
    setPlanStatus('idle');
    setPlanError('');
    setInstallPlan(null);
    getRuntimeDependencies()
      .then((next) => {
        setData(next);
        setStatus('ready');
      })
      .catch((err) => {
        setError((err as Error).message || '依赖状态读取失败');
        setStatus('failed');
      });
  };

  useEffect(load, []);

  const vm: RuntimeDependencyViewModel | null = useMemo(
    () => (data ? toRuntimeDependencyViewModel(data) : null),
    [data],
  );
  const planVm = useMemo(
    () => (installPlan ? toRuntimeDependencyInstallPlanViewModel(installPlan) : null),
    [installPlan],
  );

  const loadInstallPlan = () => {
    if (!vm || vm.installPlanCandidateIds.length === 0) return;
    setPlanStatus('loading');
    setPlanError('');
    getRuntimeDependencyInstallPlan({ selectedIds: vm.installPlanCandidateIds })
      .then((next) => {
        setInstallPlan(next);
        setPlanStatus('ready');
      })
      .catch((err) => {
        setPlanError((err as Error).message || '安装计划预检失败');
        setPlanStatus('failed');
      });
  };

  return (
    <div className="runtime-deps">
      <div className="runtime-deps-head">
        <span className="set-label">运行时依赖</span>
        <button type="button" className="btn-secondary" disabled={status === 'loading'} onClick={load}>
          {status === 'loading' ? '检测中…' : '刷新'}
        </button>
      </div>

      {status === 'loading' && !vm && <div className="modal-loading">正在读取依赖状态…</div>}
      {error && <div className="auth-error" role="alert">{error}</div>}

      {vm && (
        <>
          <div className="runtime-deps-summary">
            <span><strong>{vm.summary.readyCount}</strong> 可用</span>
            <span><strong>{vm.summary.requiredMissing}</strong> 核心异常</span>
            <span><strong>{vm.summary.optionalMissing}</strong> 可选待补</span>
            <span><strong>{vm.summary.onDemandCount}</strong> 按需组件</span>
          </div>

          {vm.requiredIssues.length > 0 && (
            <div className="runtime-deps-alert" role="status">
              核心依赖需要处理：{vm.requiredIssues.map((item) => item.label).join('、')}
            </div>
          )}

          <section className="runtime-deps-plan">
            <div>
              <strong>安装计划预检</strong>
              <span>{vm.installPlanCandidateLabel}</span>
            </div>
            <button
              type="button"
              className="btn-secondary"
              disabled={planStatus === 'loading' || vm.installPlanCandidateIds.length === 0}
              onClick={loadInstallPlan}
            >
              {planStatus === 'loading' ? '生成中…' : '生成计划'}
            </button>
          </section>
          {planError && <div className="auth-error" role="alert">{planError}</div>}
          {planVm && <RuntimeDependencyInstallPlanPreview plan={planVm} />}

          <div className="runtime-deps-sections">
            {vm.sections.map((section) => (
              <section key={section.id} className="runtime-deps-section">
                <h3>{section.title}</h3>
                <ul>
                  {section.items.map((item) => (
                    <li key={item.id} className={`runtime-dep runtime-dep-${item.severity}`}>
                      <div>
                        <strong>{item.label}</strong>
                        <span>{item.purposeLabel}</span>
                        <span className="runtime-dep-detail">{item.detailLabel}</span>
                      </div>
                      <div className="runtime-dep-meta">
                        <span>{item.statusLabel}</span>
                        <span>{item.installModeLabel}</span>
                        <span>{item.downloadLabel}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>

          <p className="modal-note">
            这里只展示检测结果和可审查安装计划；真实安装/下载会走后续按需组件流程，不会在此处执行。
          </p>
        </>
      )}
    </div>
  );
}
