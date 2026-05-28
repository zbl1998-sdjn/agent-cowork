import type {
  RuntimeDependencyCleanupPlanViewModel,
  RuntimeDependencyInstallPlanViewModel,
  RuntimeDependencyUpdatePlanViewModel,
  RuntimeDependencyViewModel,
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
                  {section.items.map((item) => {
                    const showDownload = (item.status === 'missing' || item.status === 'degraded') && Boolean(item.sourceUrl);
                    return (
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
                          {showDownload && (
                            <Button
                              variant="primary"
                              className="runtime-dep-download"
                              onClick={() => { if (item.sourceUrl) window.open(item.sourceUrl, '_blank'); }}
                              title={`在浏览器里打开下载页:${item.sourceUrl}`}
                            >
                              📥 下载安装
                            </Button>
                          )}
                        </div>
                      </li>
                    );
                  })}
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
