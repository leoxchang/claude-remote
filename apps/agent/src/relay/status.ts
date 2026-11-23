import { AgentConfigV5 } from '../config/config-v5.js';
import { RelayConnectorState } from './connector.js';

/** `agent status` 中的 relay 视图；不含任何凭证。 */
export interface RelayStatusView {
  enabled: boolean;
  baseUrl?: string;
  state: 'connecting' | 'ready' | 'stopped' | null;
  lastEpoch: number | null;
  lastError: string | null;
}

/** 组装 status 的 relay 字段；未配置 relay 时固定 enabled=false。 */
export function buildRelayStatus(
  config: AgentConfigV5,
  state: RelayConnectorState | null,
): RelayStatusView {
  if (config.relay === undefined) {
    return { enabled: false, state: null, lastEpoch: null, lastError: null };
  }
  return {
    enabled: true,
    baseUrl: config.relay.baseUrl,
    state: state?.status ?? null,
    lastEpoch: state?.lastEpoch ?? null,
    lastError: state?.lastError ?? null,
  };
}