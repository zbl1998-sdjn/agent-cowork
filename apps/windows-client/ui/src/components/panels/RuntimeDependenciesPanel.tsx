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
  type RuntimeDependencyViewModel,
} from '../../lib/runtime-dependencies';
import { RuntimeDependenciesPanelView } from './RuntimeDependenciesPanelView';

export { RuntimeDependenciesPanelView } from './RuntimeDependenciesPanelView';

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
