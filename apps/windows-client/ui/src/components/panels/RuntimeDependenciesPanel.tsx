import { useEffect, useMemo, useState } from 'react';
import {
  getRuntimeDependencies,
  getRuntimeDependencyCleanupPlan,
  getRuntimeDependencyInstallPlan,
  type RuntimeDependencyCleanupPlanResponse,
  type RuntimeDependencyInstallPlanResponse,
  type RuntimeDependencyResponse,
} from '../../lib/api';
import {
  toRuntimeDependencyCleanupPlanViewModel,
  toRuntimeDependencyInstallPlanViewModel,
  toRuntimeDependencyViewModel,
  type RuntimeDependencyCleanupPlanViewModel,
  type RuntimeDependencyInstallPlanViewModel,
  type RuntimeDependencyViewModel,
} from '../../lib/runtime-dependencies';
import { Button } from '../ui/Button';

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

export function RuntimeDependencyCleanupPlanPreview({ plan }: { plan: RuntimeDependencyCleanupPlanViewModel }) {
  return (
    <section className={`runtime-cleanup-plan runtime-cleanup-plan-${plan.requiresConfirmation ? 'warn' : plan.ok ? 'ok' : 'error'}`} aria-label="清理计划预检">
      <div className="runtime-cleanup-plan-head">
        <strong>{plan.title}</strong>
        <span>{plan.modeLabel} · {plan.targetCount} 个目标</span>
      </div>
      <p>AppData 根目录：{plan.appDataRoot}</p>
      {plan.requiresConfirmation && <p className="runtime-cleanup-warning">删除用户数据需要卸载界面二次确认。</p>}
      {plan.warnings.length > 0 && (
        <ul>
          {plan.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      {plan.targetLabels.length > 0 && (
        <div className="runtime-cleanup-list">
          <span>将清理</span>
          {plan.targetLabels.map((label) => <code key={label}>{label}</code>)}
        </div>
      )}
      {plan.retainedLabels.length > 0 && (
        <div className="runtime-cleanup-list">
          <span>将保留</span>
          {plan.retainedLabels.map((label) => <code key={label}>{label}</code>)}
        </div>
      )}
      {plan.unknownIds.length > 0 && <p className="runtime-install-plan-unknown">未知组件：{plan.unknownIds.join('、')}</p>}
    </section>
  );
}

export interface RuntimeDependenciesPanelViewProps {
  status: 'idle' | 'loading' | 'ready' | 'failed';
  error: string;
  vm: RuntimeDependencyViewModel | null;
  planStatus: 'idle' | 'loading' | 'ready' | 'failed';
  planError: string;
  planVm: RuntimeDependencyInstallPlanViewModel | null;
  cleanupStatus: 'idle' | 'loading' | 'ready' | 'failed';
  cleanupError: string;
  cleanupVm: RuntimeDependencyCleanupPlanViewModel | null;
  onLoad: () => void;
  onLoadInstallPlan: () => void;
  onLoadCleanupPlan: (keepUserData: boolean) => void;
}

export function RuntimeDependenciesPanelView({
  status,
  error,
  vm,
  planStatus,
  planError,
  planVm,
  cleanupStatus,
  cleanupError,
  cleanupVm,
  onLoad,
  onLoadInstallPlan,
  onLoadCleanupPlan,
}: RuntimeDependenciesPanelViewProps) {
  return (
    <div className="runtime-deps">
      <div className="runtime-deps-head">
        <span className="set-label">运行时依赖</span>
        <Button variant="secondary" disabled={status === 'loading'} onClick={onLoad}>
          {status === 'loading' ? '检测中…' : '刷新'}
        </Button>
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
            <Button variant="secondary" disabled={planStatus === 'loading' || vm.installPlanCandidateIds.length === 0} onClick={onLoadInstallPlan}>
              {planStatus === 'loading' ? '生成中…' : '生成计划'}
            </Button>
          </section>
          {planError && <div className="auth-error" role="alert">{planError}</div>}
          {planVm && <RuntimeDependencyInstallPlanPreview plan={planVm} />}
          <section className="runtime-deps-plan">
            <div>
              <strong>清理计划预检</strong>
              <span>{vm.cleanupPlanCandidateLabel}</span>
            </div>
            <div className="runtime-deps-plan-actions">
              <Button variant="secondary" disabled={cleanupStatus === 'loading' || vm.cleanupPlanCandidateIds.length === 0} onClick={() => onLoadCleanupPlan(true)}>
                {cleanupStatus === 'loading' ? '生成中…' : '保留数据'}
              </Button>
              <Button variant="secondary" disabled={cleanupStatus === 'loading' || vm.cleanupPlanCandidateIds.length === 0} onClick={() => onLoadCleanupPlan(false)}>
                删除数据
              </Button>
            </div>
          </section>
          {cleanupError && <div className="auth-error" role="alert">{cleanupError}</div>}
          {cleanupVm && <RuntimeDependencyCleanupPlanPreview plan={cleanupVm} />}

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
            这里只展示检测结果和可审查安装/清理计划；真实安装、下载、删除会走后续按需组件或卸载流程，不会在此处执行。
          </p>
        </>
      )}
    </div>
  );
}

export function RuntimeDependenciesPanel() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [data, setData] = useState<RuntimeDependencyResponse | null>(null);
  const [error, setError] = useState('');
  const [planStatus, setPlanStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [installPlan, setInstallPlan] = useState<RuntimeDependencyInstallPlanResponse | null>(null);
  const [planError, setPlanError] = useState('');
  const [cleanupStatus, setCleanupStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [cleanupPlan, setCleanupPlan] = useState<RuntimeDependencyCleanupPlanResponse | null>(null);
  const [cleanupError, setCleanupError] = useState('');

  const load = () => {
    setStatus('loading');
    setError('');
    setPlanStatus('idle');
    setPlanError('');
    setInstallPlan(null);
    setCleanupStatus('idle');
    setCleanupError('');
    setCleanupPlan(null);
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
  const planVm = useMemo(() => (installPlan ? toRuntimeDependencyInstallPlanViewModel(installPlan) : null), [installPlan]);
  const cleanupVm = useMemo(() => (cleanupPlan ? toRuntimeDependencyCleanupPlanViewModel(cleanupPlan) : null), [cleanupPlan]);

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

  const loadCleanupPlan = (keepUserData: boolean) => {
    if (!vm || vm.cleanupPlanCandidateIds.length === 0) return;
    setCleanupStatus('loading');
    setCleanupError('');
    getRuntimeDependencyCleanupPlan({ selectedIds: vm.cleanupPlanCandidateIds, keepUserData })
      .then((next) => {
        setCleanupPlan(next);
        setCleanupStatus('ready');
      })
      .catch((err) => {
        setCleanupError((err as Error).message || '清理计划预检失败');
        setCleanupStatus('failed');
      });
  };

  return (
    <RuntimeDependenciesPanelView
      status={status}
      error={error}
      vm={vm}
      planStatus={planStatus}
      planError={planError}
      planVm={planVm}
      cleanupStatus={cleanupStatus}
      cleanupError={cleanupError}
      cleanupVm={cleanupVm}
      onLoad={load}
      onLoadInstallPlan={loadInstallPlan}
      onLoadCleanupPlan={loadCleanupPlan}
    />
  );
}
