/**
 * S05 ASR 运行时装配：只在 Key 存在时创建真实 Provider。
 *
 * 缺 Key 或配置非法时仍注册 `/ws/asr`，start 返回 ASR_NOT_CONFIGURED；
 * Agent 主控制与文字输入不受影响。
 */
import { FastifyInstance } from 'fastify';

import {
  AsrError,
  AsrProvider,
  AsrProviderHandle,
} from './asr-protocol.js';
import { AsrConfig, loadAsrConfig } from './asr-config.js';
import { createDoubaoAsrProvider } from './doubao/doubao-asr-provider.js';
import { AsrGateway, AsrGatewayOptions } from './asr-gateway.js';
import { AsrStreamManager } from './asr-stream-manager.js';

/** 运行时状态：缺配置时仍可安全失败。 */
export type AsrRuntimeStatus = 'configured' | 'not_configured';

/** 装配结果。 */
export interface AsrRuntime {
  gateway: AsrGateway;
  status: AsrRuntimeStatus;
  close(reason: string): void;
}

/** 装配参数；providerFactory 只供测试注入 fake。 */
export interface AsrRuntimeInput {
  app: FastifyInstance;
  env: NodeJS.ProcessEnv;
  authenticate: AsrGatewayOptions['authenticate'];
  providerFactory?: (config: AsrConfig) => AsrProvider;
}

/** 创建唯一 ASR runtime；`attach` 只调用一次。 */
export function createAsrRuntime(input: AsrRuntimeInput): AsrRuntime {
  let config: AsrConfig | null = null;
  try {
    config = loadAsrConfig(input.env);
  } catch {
    // 非法 resourceId 与缺 Key 一样只禁用 ASR，不阻止 Agent 启动。
    config = null;
  }
  const provider =
    config === null
      ? new NotConfiguredProvider()
      : (input.providerFactory?.(config) ??
        createDoubaoAsrProvider(config));
  const manager = new AsrStreamManager({
    provider,
    onEvent: () => {
      // Gateway 在构造时接管事件出口。
    },
  });
  const gateway = new AsrGateway({
    authenticate: input.authenticate,
    manager,
  });
  gateway.attach(input.app);
  return {
    gateway,
    status: config === null ? 'not_configured' : 'configured',
    close(reason: string) {
      gateway.closeAll(reason);
    },
  };
}

/** 缺配置时的 Provider：start 只返回安全错误。 */
class NotConfiguredProvider implements AsrProvider {
  start(): Promise<AsrProviderHandle> {
    return Promise.reject(
      new AsrError('ASR_NOT_CONFIGURED', false, 'ASR_NOT_CONFIGURED'),
    );
  }

  write(): void {
    // 没有活动流。
  }

  finalize(): void {
    // 没有活动流。
  }

  cancel(): void {
    // 没有活动流。
  }
}