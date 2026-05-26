import type {
  RuntimeDependencyCleanupPlanViewModel,
  RuntimeDependencyInstallPlanViewModel,
  RuntimeDependencyUpdatePlanViewModel,
} from '../../lib/runtime-dependencies';

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
          {plan.componentLabels.map((label) => <li key={label}>{label}</li>)}
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
          {plan.warnings.map((warning) => <li key={warning}>{warning}</li>)}
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

export function RuntimeDependencyUpdatePlanPreview({ plan }: { plan: RuntimeDependencyUpdatePlanViewModel }) {
  return (
    <section className={`runtime-cleanup-plan runtime-cleanup-plan-${plan.ok ? 'ok' : 'error'}`} aria-label="更新保留计划预检">
      <div className="runtime-cleanup-plan-head">
        <strong>{plan.title}</strong>
        <span>{plan.versionLabel}</span>
      </div>
      <p>AppData 根目录：{plan.appDataRoot}</p>
      <p>{plan.installerInvariant}</p>
      <div className="runtime-cleanup-list">
        <span>破坏性动作</span>
        <code>{plan.destructiveActionCount} 个</code>
      </div>
      {plan.componentLabels.length > 0 && (
        <div className="runtime-cleanup-list">
          <span>保留按需组件</span>
          {plan.componentLabels.map((label) => <code key={label}>{label}</code>)}
        </div>
      )}
      {plan.retainedLabels.length > 0 && (
        <div className="runtime-cleanup-list">
          <span>保留运行时数据</span>
          {plan.retainedLabels.map((label) => <code key={label}>{label}</code>)}
        </div>
      )}
      {plan.unknownIds.length > 0 && <p className="runtime-install-plan-unknown">未知组件：{plan.unknownIds.join('、')}</p>}
    </section>
  );
}
