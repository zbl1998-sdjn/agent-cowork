// Kimi route model-connection projection (host L3 routes).
import type { KimiApiConfig } from '../engine/api-runner-config.js';
import { testModelConnection } from '../engine/model-connection-test.js';
import { listProviderRuntimeStates, providerRuntimeState } from '../engine/provider-profiles.js';

export async function inspectRouteModelConnection(
  config: KimiApiConfig,
  provider: string,
  fetchImpl?: unknown,
) {
  const activeState = providerRuntimeState(config, provider);
  const connectionResult = activeState.providerClass === 'local' && activeState.configured
    ? await testModelConnection(
      config,
      {},
      typeof fetchImpl === 'function' ? fetchImpl as typeof fetch : undefined,
    )
    : null;
  const providerStates = listProviderRuntimeStates(config).map((item) => (
    item.provider === provider && connectionResult && connectionResult.connection.status !== 'connected'
      ? {
        ...item,
        enabled: false,
        reasonCode: `model_connection_${connectionResult.connection.status}`,
        reason: connectionResult.connection.error || 'model service is not ready',
      }
      : item
  ));
  return { activeState, connectionResult, providerStates };
}
