import { useEffect, useMemo, useState } from 'react';
import { getRuntimeDependencies, type RuntimeDependencyResponse } from '../lib/api';
import { toRuntimeDependencyViewModel, type RuntimeDependencyViewModel } from '../lib/runtime-dependencies';

export function RuntimeDependenciesPanel() {
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [data, setData] = useState<RuntimeDependencyResponse | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    setStatus('loading');
    setError('');
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
            这里只展示检测结果；真实安装/下载会走后续按需组件流程，并在下载前做磁盘空间预检与来源校验。
          </p>
        </>
      )}
    </div>
  );
}
