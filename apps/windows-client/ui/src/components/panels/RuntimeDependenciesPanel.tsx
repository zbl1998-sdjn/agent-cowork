import { useEffect, useMemo, useState } from 'react';
import {
  getRuntimeDependencies,
  getRuntimeDependencyCleanupPlan,
  getRuntimeDependencyInstallPlan,
  getRuntimeDependencyUpdatePlan,
  type RuntimeDependencyCleanupPlanResponse,
  type RuntimeDependencyInstallPlanResponse,
  type RuntimeDependencyResponse,
  type RuntimeDependencyUpdatePlanResponse,
} from '../../lib/api';
import {
  toRuntimeDependencyCleanupPlanViewModel,
  toRuntimeDependencyInstallPlanViewModel,
  toRuntimeDependencyUpdatePlanViewModel,
  toRuntimeDependencyViewModel,
  type RuntimeDependencyCleanupPlanViewModel,
  type RuntimeDependencyInstallPlanViewModel,
  type RuntimeDependencyUpdatePlanViewModel,
  type RuntimeDependencyViewModel,
} from '../../lib/runtime-dependencies';
import { Button } from '../ui/Button';
import { RuntimeDependencyPlanActions } from './RuntimeDependencyPlanActions';

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
  updateStatus: 'idle' | 'loading' | 'ready' | 'failed';
  updateError: string;
  updateVm: RuntimeDependencyUpdatePlanViewModel | null;
  onLoad: () => void;
  onLoadInstallPlan: () => void;
  onLoadCleanupPlan: (keepUserData: boolean) => void;
  onLoadUpdatePlan: () => void;
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
  updateStatus,
  updateError,
  updateVm,
  onLoad,
  onLoadInstallPlan,
  onLoadCleanupPlan,
  onLoadUpdatePlan,
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
          <RuntimeDependencyPlanActions
            vm={vm}
            planStatus={planStatus}
            planError={planError}
            planVm={planVm}
            cleanupStatus={cleanupStatus}
            cleanupError={cleanupError}
            cleanupVm={cleanupVm}
            updateStatus={updateStatus}
            updateError={updateError}
            updateVm={updateVm}
            onLoadInstallPlan={onLoadInstallPlan}
            onLoadCleanupPlan={onLoadCleanupPlan}
            onLoadUpdatePlan={onLoadUpdatePlan}
          />

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
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [updatePlan, setUpdatePlan] = useState<RuntimeDependencyUpdatePlanResponse | null>(null);
  const [updateError, setUpdateError] = useState('');

  const load = () => {
    setStatus('loading');
    setError('');
    setPlanStatus('idle');
    setPlanError('');
    setInstallPlan(null);
    setCleanupStatus('idle');
    setCleanupError('');
    setCleanupPlan(null);
    setUpdateStatus('idle');
    setUpdateError('');
    setUpdatePlan(null);
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
  const updateVm = useMemo(() => (updatePlan ? toRuntimeDependencyUpdatePlanViewModel(updatePlan) : null), [updatePlan]);

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

  const loadUpdatePlan = () => {
    if (!vm || vm.updatePlanCandidateIds.length === 0) return;
    setUpdateStatus('loading');
    setUpdateError('');
    getRuntimeDependencyUpdatePlan({ selectedIds: vm.updatePlanCandidateIds })
      .then((next) => {
        setUpdatePlan(next);
        setUpdateStatus('ready');
      })
      .catch((err) => {
        setUpdateError((err as Error).message || '更新保留计划预检失败');
        setUpdateStatus('failed');
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
      updateStatus={updateStatus}
      updateError={updateError}
      updateVm={updateVm}
      onLoad={load}
      onLoadInstallPlan={loadInstallPlan}
      onLoadCleanupPlan={loadCleanupPlan}
      onLoadUpdatePlan={loadUpdatePlan}
    />
  );
}
