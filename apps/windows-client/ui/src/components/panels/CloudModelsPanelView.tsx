// CloudModelsPanelView(UI · components/panels):云端模型开关纯视图。只渲染+回调。
import type { CloudProviderOption } from '../../lib/api';
import { Button } from '../ui/Button';

export type CloudModelsPanelViewProps = {
  status: 'loading' | 'ready' | 'failed';
  enabled: boolean;
  providers: string[];
  available: CloudProviderOption[];
  error: string;
  busy: boolean;
  onToggleEnabled: (next: boolean) => void;
  onToggleProvider: (id: string, on: boolean) => void;
  onRefresh: () => void;
};

export function CloudModelsPanelView({ status, enabled, providers, available, error, busy, onToggleEnabled, onToggleProvider, onRefresh }: CloudModelsPanelViewProps) {
  const enabledSet = new Set(providers);
  return (
    <div className="cloud-models skill-packs">
      <div className="skill-packs-head">
        <div>
          <h3>云端模型</h3>
          <p className="settings-hint">办公电脑跑不动本地大模型时,可启用云端厂商——模型在厂商服务器上运行,本机不吃配置。启用即代表你同意把发给 AI 的内容发送到所选厂商;每次外发都会记入本机审计,状态条会显示外发字节数。</p>
        </div>
        <Button variant="secondary" onClick={onRefresh} disabled={status === 'loading'}>{status === 'loading' ? '刷新中…' : '刷新'}</Button>
      </div>
      {error && <div className="panel-error" role="alert">{error}</div>}

      <div className="skill-pack-item">
        <div className="skill-pack-meta">
          <code>启用云端模型</code>
          <span>{enabled ? '已启用:下方勾选的厂商可用' : '未启用:仅本地模型(Ollama/LM Studio)'}</span>
        </div>
        <Button variant={enabled ? 'secondary' : 'primary'} disabled={busy} onClick={() => onToggleEnabled(!enabled)}>
          {busy ? '保存中…' : enabled ? '关闭' : '启用'}
        </Button>
      </div>

      {enabled && (
        <ul className="skill-packs-list">
          {available.map((p) => {
            const on = enabledSet.has(p.id);
            return (
              <li key={p.id} className={`skill-pack-item${on ? '' : ' is-disabled'}`}>
                <div className="skill-pack-meta">
                  <code>{p.displayName}</code>
                  <span>{p.host}</span>
                </div>
                <Button variant={on ? 'secondary' : 'primary'} disabled={busy} onClick={() => onToggleProvider(p.id, !on)}>
                  {on ? '已放行' : '放行'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      {enabled && (
        <p className="settings-hint">放行某厂商后,到「默认模型」页选它、在「密钥」页填该厂商 API key,即可使用。</p>
      )}
    </div>
  );
}
