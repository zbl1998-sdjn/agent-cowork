// 受控能力包目录(UI · components/panels)
// ---------------------------------------------------------------------------
// 职责:只读展示能力包版本、发布者、权限和 Host 审计结论。这里不提供安装/启用/执行动作。
import { useEffect, useState } from 'react';
import { getCapabilityPacks, type CapabilityPack } from '../../lib/api';
import { Empty, ErrorState, Loading } from '../ui/StateViews';

const statusLabels = {
  bundled_trusted: '内置元数据审查通过',
  review_required: '需审查',
  blocked: '已阻止',
} as const;

const permissionLabels = {
  allow: '默认允许',
  ask: '每次询问',
  deny: '默认拒绝',
} as const;

const networkLabels = {
  none: '运行时禁止联网',
  ask: '运行时网络需询问',
  required: '运行时需要网络',
} as const;

export function CapabilityPackList({ packs }: { packs: CapabilityPack[] }) {
  if (packs.length === 0) {
    return <Empty title="暂无能力包" message="Host 尚未发布任何受控能力包清单。" />;
  }
  return (
    <ul className="tool-list capability-pack-list">
      {packs.map((pack) => (
        <li key={pack.id}>
          <div className="panel-row">
            <strong>{pack.name}</strong>
            <code>v{pack.version}</code>
            <span className="tool-src">{statusLabels[pack.governance.status]}</span>
            {!pack.governance.executable && <span className="tool-src">不可执行</span>}
          </div>
          <p>{pack.description}</p>
          <p className="panel-note">发布者：{pack.publisher} · 模式：{pack.installMode}</p>
          {pack.requiredPackIds.length > 0 && (
            <p className="panel-note">
              必需能力包：{pack.requiredPackIds.join('、')}
            </p>
          )}
          <p className="panel-note">
            安全要求：{pack.security.signed
              ? 'signed=true（仅静态清单声明，当前未执行密码学验签）'
              : 'signed=false（无签名声明）'}
            {' · '}
            {pack.security.sandboxRequired ? '需要沙箱' : '不要求沙箱'}
            {' · '}
            {networkLabels[pack.security.networkDuringRuntime]}
          </p>
          {pack.governance.reasons.length > 0 && (
            <p className="panel-note">
              治理原因：{pack.governance.reasons.join('、')}
            </p>
          )}
          <p className="panel-note">权限要求：</p>
          <ul>
            {pack.permissions.map((permission, index) => (
              <li key={`${permission.kind}:${permission.scope}:${index}`}>
                {permission.kind} · {permission.scope} · {permissionLabels[permission.default]}
                {' · '}
                {permission.reason}
              </li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

export function CapabilityPacksSection({
  load = getCapabilityPacks,
}: {
  load?: () => Promise<CapabilityPack[]>;
}) {
  const [packs, setPacks] = useState<CapabilityPack[] | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let active = true;
    setPacks(null);
    setError('');
    void load().then(
      (value) => { if (active) setPacks(value); },
      (reason: unknown) => { if (active) setError((reason as Error).message || String(reason)); },
    );
    return () => { active = false; };
  }, [load, reload]);

  return (
    <section className="panel-section capability-packs-section">
      <h3>受控能力包</h3>
      <p className="panel-note">只展示和预检；不会自动下载、安装、启用或执行第三方能力。</p>
      {error ? (
        <ErrorState
          title="能力包目录加载失败"
          message={error}
          onRetry={() => setReload((value) => value + 1)}
        />
      ) : packs === null ? (
        <Loading message="加载能力包治理目录…" />
      ) : (
        <CapabilityPackList packs={packs} />
      )}
    </section>
  );
}
