// CloudModelsPanel(UI · components/panels):设置页「云端模型」区——总开关 + 逐厂商勾选。
// 办公电脑配置差跑不动本地模型时,在这里显式启用云端厂商;启用即知情:数据会发送到该厂商。
import { useEffect, useState } from 'react';
import { getCloudModels, setCloudModels, type CloudProviderOption } from '../../lib/api';
import { humanizeError } from '../../lib/friendly-error';
import { CloudModelsPanelView } from './CloudModelsPanelView';
import { OllamaCloudSection } from './OllamaCloudSection';

export function CloudModelsPanel() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [enabled, setEnabled] = useState(false);
  const [providers, setProviders] = useState<string[]>([]);
  const [available, setAvailable] = useState<CloudProviderOption[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => {
    setStatus('loading');
    setError('');
    getCloudModels()
      .then((next) => {
        setEnabled(next.enabled);
        setProviders(next.providers);
        setAvailable(next.available);
        setStatus('ready');
      })
      .catch((err) => {
        setError(humanizeError(err, { action: '读取云端设置' }));
        setStatus('failed');
      });
  };
  useEffect(load, []);

  const save = (nextEnabled: boolean, nextProviders: string[]) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setCloudModels(nextEnabled, nextProviders)
      .then((next) => {
        setEnabled(next.enabled);
        setProviders(next.providers);
        setAvailable(next.available);
      })
      .catch((err) => setError(humanizeError(err, { action: '保存云端设置' })))
      .finally(() => setBusy(false));
  };

  const onToggleEnabled = (next: boolean) => {
    // 首次开启即知情确认:数据会发送到所选云厂商。
    if (next && typeof window !== 'undefined' && !window.confirm('启用后,你发给 AI 的内容会发送到所选云服务商处理。确定启用云端模型？')) return;
    save(next, providers);
  };

  const onToggleProvider = (id: string, on: boolean) => {
    const next = on ? [...new Set([...providers, id])] : providers.filter((p) => p !== id);
    save(enabled, next);
  };

  return (
    <div className="cloud-models">
      <OllamaCloudSection />
      <CloudModelsPanelView
        status={status}
        enabled={enabled}
        providers={providers}
        available={available}
        error={error}
        busy={busy}
        onToggleEnabled={onToggleEnabled}
        onToggleProvider={onToggleProvider}
        onRefresh={load}
      />
    </div>
  );
}
