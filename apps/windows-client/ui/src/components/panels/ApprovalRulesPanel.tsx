// ApprovalRulesPanel(UI · components/panels):设置页「审批规则」区——列出本工作区
// always-allow 工具并支持删除;新增只能经审批卡的「本工作区总是允许」决定。
import { useEffect, useState } from 'react';
import { getApprovalRules, removeApprovalRule } from '../../lib/api';
import { humanizeError } from '../../lib/friendly-error';
import { Button } from '../ui/Button';

export function ApprovalRulesPanel() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [rules, setRules] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busyTool, setBusyTool] = useState('');

  const load = () => {
    setStatus('loading');
    setError('');
    getApprovalRules()
      .then((next) => {
        setRules(next);
        setStatus('ready');
      })
      .catch((err) => {
        setError(humanizeError(err, { action: '读取审批规则' }));
        setStatus('failed');
      });
  };
  useEffect(load, []);

  const onRemove = (tool: string) => {
    if (busyTool) return;
    setBusyTool(tool);
    setError('');
    removeApprovalRule(tool)
      .then(setRules)
      .catch((err) => setError(humanizeError(err, { action: '删除审批规则' })))
      .finally(() => setBusyTool(''));
  };

  return (
    <div className="approval-rules">
      <div className="skill-packs-head">
        <div>
          <h3>审批规则(本工作区总是允许)</h3>
          <p className="settings-hint">下列工具在本工作区免逐次审批;规则只能在审批卡上选「本工作区总是允许」时新增,这里可随时收回。高风险工具永远逐次审批,不受规则影响。</p>
        </div>
        <Button variant="secondary" onClick={load} disabled={status === 'loading'}>{status === 'loading' ? '刷新中…' : '刷新'}</Button>
      </div>
      {error && <div className="panel-error" role="alert">{error}</div>}
      {status === 'ready' && rules.length === 0 && <p className="settings-hint">当前没有已保存的放行规则。</p>}
      {rules.length > 0 && (
        <ul className="skill-packs-list">
          {rules.map((tool) => (
            <li key={tool} className="skill-pack-item">
              <div className="skill-pack-meta"><code>{tool}</code></div>
              <Button variant="danger" disabled={Boolean(busyTool)} onClick={() => onRemove(tool)}>
                {busyTool === tool ? '删除中…' : '删除'}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
