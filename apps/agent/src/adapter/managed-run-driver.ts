import {
  PermissionResult,
  SdkPermissionRequest,
} from '../approval/approval-types.js';
import { AdapterEvent } from '../events/adapter-events.js';

/** Adapter 需要的权限门面；由 PermissionBroker 实现。 */
export interface PermissionGate {
  request(
    runId: string,
    request: SdkPermissionRequest,
  ): Promise<PermissionResult>;
}

/** 启动一次受管 run 的全部输入；句柄必须同步返回。 */
export interface ManagedRunStart {
  sessionId: string;
  workspaceId: string;
  claudeSessionId: string | null;
  runId: string;
  adapterGeneration: number;
  text: string;
  cwd: string;
  /** 发起该 run 的已认证设备；审批绑定到该设备。 */
  deviceId: string;
  permissionBroker: PermissionGate;
  onEvent: (event: AdapterEvent) => void;
}

/** 一次 run 的同步句柄；事件在 resumeEvents 后交付。 */
export interface ManagedRunHandle {
  interrupt(): Promise<void>;
  close(): Promise<void>;
  resumeEvents(): void;
}

/** SDK 中立驱动；只有 Adapter 实现真实 SDK。 */
export interface ManagedRunDriver {
  startRun(input: ManagedRunStart): ManagedRunHandle;
}