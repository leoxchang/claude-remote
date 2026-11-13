import { AgentError } from '../command/errors.js';
import { DeviceStorePort } from '../store/device-store.js';
import { RunRepository } from '../storage/repositories/run-repository.js';

/** run prompt 正文上限；响应只含 runId/text。 */
export const MAX_RUN_PROMPT_BYTES = 16 * 1024;

export interface RunPromptControllerDeps {
  runs: RunRepository;
  devices: DeviceStorePort;
}

/**
 * 认证只读 prompt；不占 seq、不写 command/Journal/日志。
 *
 * 只有当前已配对且是该 run 发起设备才可读。
 */
export class RunPromptController {
  constructor(private readonly deps: RunPromptControllerDeps) {}

  read(
    runId: string,
    deviceId: string,
  ): { runId: string; text: string } {
    const run = this.deps.runs.get(runId);
    if (run === undefined || run.promptText === null) {
      throw new AgentError('RUN_NOT_FOUND');
    }
    if (run.deviceId !== deviceId) throw new AgentError('FORBIDDEN');
    const active = this.deps.devices
      .list()
      .some(
        (device) => device.deviceId === deviceId && device.revokedAt === null,
      );
    if (!active) throw new AgentError('FORBIDDEN');
    if (Buffer.byteLength(run.promptText, 'utf8') > MAX_RUN_PROMPT_BYTES) {
      throw new AgentError('RUN_NOT_RECOVERABLE');
    }
    return { runId: run.runId, text: run.promptText };
  }
}