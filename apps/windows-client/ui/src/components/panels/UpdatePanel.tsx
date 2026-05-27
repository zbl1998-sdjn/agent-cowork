import { useState } from 'react';
import { checkDesktopUpdate, installDesktopUpdate, isDesktop, type DesktopUpdateStatus } from '../../lib/api';
import { Button } from '../ui/Button';

type UpdateStatus = 'idle' | 'checking' | 'ready' | 'installing' | 'installed' | 'failed';

export interface UpdatePanelViewProps {
  desktop: boolean;
  status: UpdateStatus;
  update: DesktopUpdateStatus | null;
  error: string;
  onCheck: () => void;
  onInstall: () => void;
}

export function UpdatePanelView({ desktop, status, update, error, onCheck, onInstall }: UpdatePanelViewProps) {
  const checking = status === 'checking';
  const installing = status === 'installing';
  const available = Boolean(update?.available);
  return (
    <section className="runtime-deps update-panel" aria-label="桌面更新">
      <div className="runtime-deps-head">
        <span className="set-label">桌面更新</span>
        <Button variant="secondary" disabled={!desktop || checking || installing} onClick={onCheck}>
          {checking ? '检查中...' : '检查更新'}
        </Button>
      </div>
      {!desktop && <div className="auth-error" role="status">桌面更新仅在安装版中可用。</div>}
      {error && <div className="auth-error" role="alert">{error}</div>}
      {update && (
        <section className={`runtime-cleanup-plan runtime-cleanup-plan-${available ? 'warn' : 'ok'}`}>
          <div className="runtime-cleanup-plan-head">
            <strong>{available ? `发现 ${update.version}` : '当前已是最新版本'}</strong>
            <span>{update.currentVersion}</span>
          </div>
          {update.date && <p>{update.date}</p>}
          {update.body && <p>{update.body}</p>}
          {available && (
            <Button variant="primary" disabled={installing} onClick={onInstall}>
              {installing ? '安装中...' : '下载并安装'}
            </Button>
          )}
        </section>
      )}
      {status === 'installed' && <div className="saved-tip">更新已安装，重启应用后生效。</div>}
    </section>
  );
}

export function UpdatePanel() {
  const desktop = isDesktop();
  const [status, setStatus] = useState<UpdateStatus>('idle');
  const [update, setUpdate] = useState<DesktopUpdateStatus | null>(null);
  const [error, setError] = useState('');

  const check = () => {
    setStatus('checking'); setError('');
    checkDesktopUpdate()
      .then((result) => { setUpdate(result); setStatus('ready'); })
      .catch((err) => { setError((err as Error).message || '更新检查失败'); setStatus('failed'); });
  };
  const install = () => {
    setStatus('installing'); setError('');
    installDesktopUpdate()
      .then(() => setStatus('installed'))
      .catch((err) => { setError((err as Error).message || '更新安装失败'); setStatus('failed'); });
  };

  return <UpdatePanelView desktop={desktop} status={status} update={update} error={error} onCheck={check} onInstall={install} />;
}
