import { TerminalRunStatus } from '../domain/types.js';
import { AdapterEvent } from '../events/adapter-events.js';
import { EventNormalizer } from '../events/normalizer.js';
import { SessionRegistry } from '../session/session-registry.js';
import {
  CancelAccepted,
  PromptAccepted,
  QueueRemoved,
  RunScheduler,
} from './run-scheduler.js';

/** interrupt 后等待终态的上限。 */
export const INTERRUPT_TIMEOUT_MS = 10_000;

/** 多会话 RunController 依赖。 */
export interface ManagedRunControllerOptions {
  scheduler: RunScheduler;
  sessions: SessionRegistry;
  normalizer: EventNormalizer;
  interruptTimeoutMs?: number;
}

/**
 * 多会话命令门面的执行侧：
 * 调度由 RunScheduler 完成，这里只做取消、终态清理与事件路由。
 */
export class ManagedRunController {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(private readonly options: ManagedRunControllerOptions) {
    this.options.scheduler.setEventHandler((event, context) => {
      this.handleAdapterEvent(event, context);
    });
  }

  /** 接受一条 prompt；忙碌时进入队列而不是报错。 */
  sendPrompt(
    sessionId: string,
    text: string,
    commandId: string,
    traceId: string,
  ): Promise<PromptAccepted> {
    try {
      return Promise.resolve(
        this.options.scheduler.enqueue({ sessionId, text, commandId, traceId }),
      );
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  }

  /** 取消指定 run；重复取消不再调用第二次 interrupt。 */
  async cancel(sessionId: string, runId: string): Promise<CancelAccepted> {
    const decision = this.options.scheduler.beginCancel(sessionId, runId);
    if (decision.outcome === 'alreadyCancelling') {
      return { sessionId, runId, status: 'cancelling' };
    }
    if (decision.handle !== null) {
      try {
        await decision.handle.interrupt();
      } catch {
        await this.finish(sessionId, runId, 'interrupted', 'INTERRUPT_FAILED');
        return { sessionId, runId, status: 'cancelling' };
      }
    }
    this.armTimeout(sessionId, runId);
    return { sessionId, runId, status: 'cancelling' };
  }

  /** 移除 queued run；从不调用 Adapter。 */
  removeQueued(sessionId: string, runId: string): Promise<QueueRemoved> {
    try {
      return Promise.resolve(
        this.options.scheduler.removeQueued(sessionId, runId),
      );
    } catch (error: unknown) {
      return Promise.reject(error);
    }
  }

  private handleAdapterEvent(
    event: AdapterEvent,
    context: { runId: string; generation: number },
  ): void {
    if (!this.options.scheduler.isCurrent(context.runId, context.generation)) {
      return;
    }
    if (event.kind === 'init') {
      try {
        this.options.sessions.recordClaudeSession(
          event.sessionId,
          event.runId,
          event.claudeSessionId,
        );
      } catch {
        void this.finish(
          event.sessionId,
          event.runId,
          'failed',
          'CLAUDE_SESSION_CONFLICT',
        );
        return;
      }
      this.options.normalizer.consume(event);
      this.options.scheduler.markRunning(event.sessionId, event.runId);
      return;
    }

    this.options.normalizer.consume(event);
    if (event.kind === 'textDelta' || event.kind === 'toolStarted') {
      this.options.scheduler.markRunning(event.sessionId, event.runId);
      return;
    }
    if (event.kind === 'runResult') {
      void this.finish(
        event.sessionId,
        event.runId,
        event.status,
        event.errorSummary,
      );
    }
  }

  /** 有界取消：超时仍无终态时关闭并标为 interrupted。 */
  private armTimeout(sessionId: string, runId: string): void {
    this.clearTimer(runId);
    const timeout = this.options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS;
    this.timers.set(
      runId,
      setTimeout(() => {
        this.timers.delete(runId);
        void this.finish(sessionId, runId, 'interrupted', 'INTERRUPT_TIMEOUT');
      }, timeout),
    );
  }

  /** 先关闭句柄再写终态并释放执行槽。 */
  private async finish(
    sessionId: string,
    runId: string,
    status: TerminalRunStatus,
    errorSummary?: string,
  ): Promise<void> {
    this.clearTimer(runId);
    await this.options.scheduler.closeHandle(runId);
    try {
      this.options.scheduler.complete({
        sessionId,
        runId,
        status,
        ...(errorSummary === undefined ? {} : { errorSummary }),
      });
    } catch {
      // run 已被更早的终态处理；重复完成不是错误。
    }
  }

  private clearTimer(runId: string): void {
    const timer = this.timers.get(runId);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.timers.delete(runId);
  }
}