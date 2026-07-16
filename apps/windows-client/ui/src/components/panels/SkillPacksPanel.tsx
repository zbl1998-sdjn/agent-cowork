// SkillPacksPanel(UI · components/panels):设置页「技能包」区容器——加载 SKILL.md 技能包列表并处理启停。
import { useEffect, useState } from 'react';
import { getSkillPacks, toggleSkillPack, type SkillPack } from '../../lib/api';
import { humanizeError } from '../../lib/friendly-error';
import { SkillPacksPanelView } from './SkillPacksPanelView';

export function SkillPacksPanel() {
  const [status, setStatus] = useState<'loading' | 'ready' | 'failed'>('loading');
  const [packs, setPacks] = useState<SkillPack[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busyName, setBusyName] = useState('');

  const load = () => {
    setStatus('loading');
    setError('');
    getSkillPacks()
      .then((next) => {
        setPacks(next.packs);
        setWarnings(next.warnings);
        setStatus('ready');
      })
      .catch((err) => {
        setError(humanizeError(err, { action: '读取技能包' }));
        setStatus('failed');
      });
  };
  useEffect(load, []);

  const onToggle = (pack: SkillPack) => {
    if (busyName) return;
    setBusyName(pack.name);
    setError('');
    toggleSkillPack(pack.name, !pack.enabled)
      .then((next) => {
        setPacks(next.packs);
        setWarnings(next.warnings);
      })
      .catch((err) => setError(humanizeError(err, { action: '切换技能包' })))
      .finally(() => setBusyName(''));
  };

  return (
    <SkillPacksPanelView
      status={status}
      packs={packs}
      warnings={warnings}
      error={error}
      busyName={busyName}
      onToggle={onToggle}
      onRefresh={load}
    />
  );
}
