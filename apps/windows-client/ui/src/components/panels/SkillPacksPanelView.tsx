// SkillPacksPanelView(UI · components/panels):技能包列表纯视图——名称/说明/启停按钮/跳过原因。只渲染+回调。
import type { SkillPack } from '../../lib/api';
import { Button } from '../ui/Button';

export type SkillPacksPanelViewProps = {
  status: 'loading' | 'ready' | 'failed';
  packs: SkillPack[];
  warnings: string[];
  error: string;
  busyName: string;
  onToggle: (pack: SkillPack) => void;
  onRefresh: () => void;
};

export function SkillPacksPanelView({ status, packs, warnings, error, busyName, onToggle, onRefresh }: SkillPacksPanelViewProps) {
  return (
    <div className="skill-packs">
      <div className="skill-packs-head">
        <div>
          <h3>技能包(SKILL.md 标准)</h3>
          <p className="settings-hint">把符合 agentskills.io 标准的技能包放进工作区 <code>.AgentCowork/skills/&lt;名称&gt;/</code> 后,这里会列出;对话时按需注入,附带脚本不会被执行。</p>
        </div>
        <Button variant="secondary" onClick={onRefresh} disabled={status === 'loading'}>{status === 'loading' ? '刷新中…' : '刷新'}</Button>
      </div>
      {error && <div className="panel-error" role="alert">{error}</div>}
      {status === 'ready' && packs.length === 0 && (
        <p className="settings-hint">当前工作区还没有发现技能包。</p>
      )}
      {packs.length > 0 && (
        <ul className="skill-packs-list">
          {packs.map((pack) => (
            <li key={pack.name} className={`skill-pack-item${pack.enabled ? '' : ' is-disabled'}`}>
              <div className="skill-pack-meta">
                <code>{pack.name}</code>
                <span>{pack.description}</span>
              </div>
              <Button
                variant={pack.enabled ? 'secondary' : 'primary'}
                disabled={Boolean(busyName)}
                onClick={() => onToggle(pack)}
              >
                {busyName === pack.name ? '切换中…' : pack.enabled ? '停用' : '启用'}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <div className="skill-packs-warnings">
          <h4>已跳过的目录</h4>
          <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
