import { AdapterEvent } from '../events/adapter-events.js';
import { EventNormalizer } from '../events/normalizer.js';
import { SessionRepository } from '../storage/repositories/session-repository.js';
import { DurableRunScheduler } from './durable-run-scheduler.js';
import { CancelAccepted } from './run-scheduler.js';

/** interrupt 后等待终态的上限。 */
export const DURABLE_INTERRUPT_TIMEOUT_MS = 10_000;

export interface DurableRunApprovalInvalidator {
  invalidateRun(runId: string, reason: 'run_cancelled' | 'sdk_aborted'): number;
}

export interface DurableRunControllerOptions {
  scheduler: DurableRunScheduler;
  sessions: SessionRepository;
  normalizer: EventNormalizer;
  permissionBroker?: DurableRunApprovalInvalidator;
  interruptTimeoutMs?: number;
}

/**
 * DB 调度器的事件与取消侧。
 *
 * 事件只更新 DB 投影；取消先提交 cancelling，再 expire 审批与 interrupt。
 */
export class DurableRunController {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: DurableRunControllerOptions) {
    this.options.scheduler.setEventHandler((event, context) => {
      this.handleAdapterEvent(event, context);
    });
  }

  /** 取消：beginCancel 已提交后才 interrupt。 */
  async cancel(runId: string): Promise<CancelAccepted> {
    const decision = this.options.scheduler.beginCancel(runId);
    const accepted: CancelAccepted = {
      sessionId: decision.run.sessionId,
      runId,
      status: 'cancelling',
    };
    if (decision.outcome === 'alreadyCancelling') return accepted;
    this.options.permissionBroker?.invalidateRun(runId, 'run_cancelled');
    if (decision.handle !== null) {
      try {
        await decision.handle.interrupt();
      } catch {
        await this.finish(runId, 'interrupted', 'INTERRUPT_FAILED');
        return accepted;
      }
    }
    this.armTimeout(runId);
    return accepted;
  }

  private handleAdapterEvent(
    event: AdapterEvent,
    context: { runId: string; generation: number },
  ): void {
    if (!this.options.scheduler.isCurrent(context.runId, context.generation)) {
      return;
    }
    if (event.kind === 'init') {
      const session = this.options.sessions.get(event.sessionId);
      if (session !== undefined) {
        this.options.sessions.update({
          ...session,
          claudeSessionId: event.claudeSessionId,
        });
      }
      this.options.normalizer.consume(event);
      this.options.scheduler.markRunning(event.runId);
      return;
    }
    this.options.normalizer.consume(event);
    if (event.kind === 'textDelta' || event.kind === 'toolStarted') {
      this.options.scheduler.markRunning(event.runId);
      return;
    }
    if (event.kind === 'runResult') {
      void this.finish(event.runId, event.status, event.errorSummary);
    }
  }

  private armTimeout(runId: string): void {
    this.clearTimer(runId);
    const timeout =
      this.options.interruptTimeoutMs ?? DURABLE_INTERRUPT_TIMEOUT_MS;
    this.timers.set(
      runId,
      setTimeout(() => {
        this.timers.delete(runId);
        void this.finish(runId, 'interrupted', 'INTERRUPT_TIMEOUT');
      }, timeout),
    );
  }

  private async finish(
    runId: string,
    status: 'succeeded' | 'failed' | 'cancelled' | 'interrupted',
    errorSummary?: string,
  ): Promise<void> {
    this.clearTimer(runId);
    this.options.permissionBroker?.invalidateRun(
      runId,
      status === 'cancelled' ? 'run_cancelled' : 'sdk_aborted',
    );
    await this.options.scheduler.closeHandle(runId);
    try {
      this.options.scheduler.complete({
        runId,
        status,
        ...(errorSummary === undefined ? {} : { errorSummary }),
      });
    } catch {
      // 已被更早的终态处理；重复完成不是错误。
    }
    this.options.normalizer.clearRun(runId);
  }

  private clearTimer(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(runId);
  }
}