import type {
  RuntimeDependencyCleanupPlanViewModel,
  RuntimeDependencyInstallPlanViewModel,
  RuntimeDependencyUpdatePlanViewModel,
  RuntimeDependencyViewModel,
} from '../../lib/runtime-dependencies';
import { Button } from '../ui/Button';
import {
  RuntimeDependencyCleanupPlanPreview,
  RuntimeDependencyInstallPlanPreview,
  RuntimeDependencyUpdatePlanPreview,
} from './RuntimeDependencyPlanPreviews';

type PlanStatus = 'idle' | 'loading' | 'ready' | 'failed';

export interface RuntimeDependencyPlanActionsProps {
  vm: RuntimeDependencyViewModel;
  planStatus: PlanStatus;
  planError: string;
  planVm: RuntimeDependencyInstallPlanViewModel | null;
  cleanupStatus: PlanStatus;
  cleanupError: string;
  cleanupVm: RuntimeDependencyCleanupPlanViewModel | null;
  updateStatus: PlanStatus;
  updateError: string;
  updateVm: RuntimeDependencyUpdatePlanViewModel | null;
  onLoadInstallPlan: () => void;
  onLoadCleanupPlan: (keepUserData: boolean) => void;
  onLoadUpdatePlan: () => void;
}

export function RuntimeDependencyPlanActions({
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
  onLoadInstallPlan,
  onLoadCleanupPlan,
  onLoadUpdatePlan,
}: RuntimeDependencyPlanActionsProps) {
  return (
    <>
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
      <section className="runtime-deps-plan">
        <div>
          <strong>更新保留计划预检</strong>
          <span>{vm.updatePlanCandidateLabel}</span>
        </div>
        <Button variant="secondary" disabled={updateStatus === 'loading' || vm.updatePlanCandidateIds.length === 0} onClick={onLoadUpdatePlan}>
          {updateStatus === 'loading' ? '生成中…' : '生成保留计划'}
        </Button>
      </section>
      {updateError && <div className="auth-error" role="alert">{updateError}</div>}
      {updateVm && <RuntimeDependencyUpdatePlanPreview plan={updateVm} />}
    </>
  );
}
