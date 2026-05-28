import { Button } from '../ui/Button';

export function ConnectorSearchAction({ onSearch }: { onSearch: () => void }) {
  return <Button onClick={onSearch}>搜索</Button>;
}

export function ConnectorOAuthAction({
  busy,
  connected,
  hasSession,
  approved,
  missingConfig,
  onApprove,
  onStart,
  onComplete,
  onRevoke,
}: {
  busy: boolean;
  connected: boolean;
  hasSession: boolean;
  approved: boolean;
  missingConfig: boolean;
  onApprove: () => void;
  onStart: () => void;
  onComplete: () => void;
  onRevoke: () => void;
}) {
  // Labels avoid "OAuth" wherever possible — non-technical users see "网页授权"
  // instead. The 4-state machine (待审批 → 审批 → 开始 → 完成) stays intact.
  const label = busy
    ? (connected ? '撤销中…' : hasSession ? '确认中…' : approved ? '授权中…' : '审批中…')
    : connected ? '撤销授权' : missingConfig ? '待配置 网页授权' : hasSession ? '完成授权' : approved ? '去登录授权' : '审批权限';
  const onClick = connected ? onRevoke : hasSession ? onComplete : approved ? onStart : onApprove;
  return (
    <Button disabled={busy || missingConfig} onClick={onClick}>
      {label}
    </Button>
  );
}

export function ConnectorBuiltinAction({
  busy,
  connected,
  onConnect,
  onDisconnect,
}: {
  busy: boolean;
  connected: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  return (
    <Button disabled={busy} onClick={connected ? onDisconnect : onConnect}>
      {busy ? (connected ? '断开中…' : '连接中…') : connected ? '断开连接' : '一键连接'}
    </Button>
  );
}
