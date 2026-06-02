// 连接器 OAuth 状态读取(UI · 组件层 · components/panels)
// ---------------------------------------------------------------------------
// 职责:面板辅助逻辑——筛出 oauth-device 类型连接器,经 lib/api 查询授权状态并归一化为视图对象(已连/账号/是否已配置),失败兜底为未连。
// 依赖/对应路由:lib/api 的 getOAuthConnectorStatus。导出:OAuthStatusView 类型、readConnectorOAuthStatus()。
import { getOAuthConnectorStatus, type ConnectorInfo } from '../../lib/api';

export type OAuthStatusView = {
  connected: boolean;
  accounts: string[];
  configured?: boolean | undefined;
  configurationMessage?: string | undefined;
  requiredEnv?: string[] | undefined;
};

export async function readConnectorOAuthStatus(items: ConnectorInfo[]) {
  const oauthItems = items.filter((connector) => connector.auth?.type === 'oauth-device');
  const next: Record<string, OAuthStatusView> = {};
  await Promise.all(oauthItems.map(async (connector) => {
    try {
      const status = await getOAuthConnectorStatus(connector.id);
      next[connector.id] = {
        connected: status.connected,
        configured: status.configured,
        configurationMessage: status.configurationMessage,
        requiredEnv: status.requiredEnv,
        accounts: (status.accounts || []).map((account) => account.accountId),
      };
    } catch {
      next[connector.id] = { connected: false, accounts: [] };
    }
  }));
  return next;
}
