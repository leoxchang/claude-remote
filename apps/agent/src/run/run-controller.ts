import {
  AgentDriver,
  AgentRunHandle,
} from '../adapter/agent-driver.js';
import { AgentError } from '../command/errors.js';
import { RunRecord } from '../domain/types.js';
import { AdapterEvent } from '../events/adapter-events.js';
import { EventJournal } from '../events/journal.js';
import { EventNormalizer } from '../events/normalizer.js';
import { randomBase64Url } from '../security/random.js';
import { RunAccepted, SessionController } from '../session/session-controller.js';

const RUN_ID_BYTES = 9;

/** interrupt 后等待终态的上限。 */
export const INTERRUPT_TIMEOUT_MS = 10_000;

/** RunController 依赖。 */
export interface RunControllerOptions {
  sessions: SessionController;
  driver: AgentDriver;
  journal: EventJournal;
  normalizer: EventNormalizer;
  cwd: string;
  interruptTimeoutMs?: number;
}

interface ActiveRun {
  record: RunRecord;
  handle: AgentRunHandle | null;
  interruptTimer: ReturnType<typeof setTimeout> | null;
}

/** 单会话单活跃 run 的状态机；一次 run 对应一次 driver.startRun。 */
export class RunController {
  private readonly runs = new Map<string, ActiveRun>();

  constructor(private readonly options: RunControllerOptions) {}

  /** 接受一条 prompt；忙碌时返回 SESSION_BUSY，不排队。 */
  async sendPrompt(
    sessionId: string,
    text: string,
    commandId: string,
  ): Promise<RunAccepted> {
    const session = this.options.sessions.get(sessionId);
    if (this.runs.has(sessionId)) {
      throw new AgentError('SESSION_BUSY', 'run in progress', true);
    }

    const runId = `run_${randomBase64Url(RUN_ID_BYTES)}`;
    const active: ActiveRun = {
      record: { runId, sessionId, commandId, status: 'starting' },
      handle: null,
      interruptTimer: null,
    };
    this.runs.set(sessionId, active);
    this.options.sessions.update(sessionId, { status: 'running' });

    try {
      active.handle = await this.options.driver.startRun({
        sessionId,
        claudeSessionId: session.claudeSessionId,
        runId,
        text,
        cwd: this.options.cwd,
        onEvent: (event) => {
          this.onEvent(sessionId, event);
        },
      });
    } catch (error: unknown) {
      this.runs.delete(sessionId);
      this.options.sessions.update(sessionId, { status: 'ready' });
      if (error instanceof AgentError) throw error;
      throw new AgentError('INTERNAL_ERROR');
    }

    return { sessionId, runId, status: 'starting' };
  }

  /** 取消指定 run；只影响该 runId。 */
  async cancel(sessionId: string, runId: string): Promise<RunAccepted> {
    this.options.sessions.get(sessionId);
    const active = this.runs.get(sessionId);
    if (active === undefined || active.record.runId !== runId) {
      throw new AgentError('RUN_NOT_ACTIVE');
    }

    active.record = { ...active.record, status: 'cancelling' };
    try {
      await active.handle?.interrupt();
    } catch {
      this.finishWith(sessionId, 'interrupted');
      return { sessionId, runId, status: 'cancelling' };
    }
    if (this.runs.has(sessionId)) {
      active.interruptTimer = setTimeout(() => {
        this.finishWith(sessionId, 'interrupted');
      }, this.options.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS);
    }
    return { sessionId, runId, status: 'cancelling' };
  }

  /** 当前活跃 run 的副本；没有时返回 null。 */
  activeRun(sessionId: string): RunRecord | null {
    const active = this.runs.get(sessionId);
    return active === undefined ? null : { ...active.record };
  }

  private onEvent(sessionId: string, event: AdapterEvent): void {
    this.options.normalizer.consume(event);
    const active = this.runs.get(sessionId);

    if (event.kind === 'init') {
      this.options.sessions.update(sessionId, {
        claudeSessionId: event.claudeSessionId,
      });
      return;
    }
    if (event.kind === 'textDelta' || event.kind === 'toolStarted') {
      if (active !== undefined) {
        active.record = { ...active.record, status: 'running' };
      }
      return;
    }
    if (event.kind === 'runResult') {
      this.complete(sessionId);
    }
  }

  /** 驱动给出终态：关闭句柄并释放会话。 */
  private complete(sessionId: string): void {
    const active = this.runs.get(sessionId);
    if (active === undefined) return;
    this.release(active);
    this.runs.delete(sessionId);
    this.options.sessions.update(sessionId, { status: 'ready' });
  }

  /** 没有终态时由控制器补发 run.completed。 */
  private finishWith(
    sessionId: string,
    status: 'interrupted' | 'failed',
  ): void {
    const active = this.runs.get(sessionId);
    if (active === undefined) return;
    this.release(active);
    this.runs.delete(sessionId);
    this.options.sessions.update(sessionId, { status: 'ready' });
    this.options.normalizer.consume({
      kind: 'runResult',
      sessionId,
      runId: active.record.runId,
      status,
    } satisfies AdapterEvent);
  }

  private release(active: ActiveRun): void {
    if (active.interruptTimer !== null) {
      clearTimeout(active.interruptTimer);
      active.interruptTimer = null;
    }
    active.handle?.close();
  }
}