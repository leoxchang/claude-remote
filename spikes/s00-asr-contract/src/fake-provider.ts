import { AsrConfig, AsrEvent, AsrProvider, AsrStreamHandle } from './types.js';

/** 可脚本化的伪 Provider：测试决定何时发送哪种事件。 */
export class FakeAsrProvider implements AsrProvider {
  readonly emittedTypes: string[] = [];
  readonly finalizedStreams: string[] = [];
  readonly cancelledStreams: string[] = [];
  lastWrite: { streamId: string; bytes: number } | undefined;
  lastConfig: AsrConfig | undefined;

  private readonly emitters = new Map<string, (event: AsrEvent) => void>();

  async start(
    handle: AsrStreamHandle,
    config: AsrConfig,
    emit: (event: AsrEvent) => void,
  ): Promise<void> {
    this.lastConfig = config;
    this.emitters.set(handle.streamId, (event) => {
      this.emittedTypes.push(event.type);
      emit(event);
    });
  }

  async write(handle: AsrStreamHandle, audio: Uint8Array): Promise<void> {
    this.lastWrite = { streamId: handle.streamId, bytes: audio.length };
  }

  async finalize(handle: AsrStreamHandle): Promise<void> {
    this.finalizedStreams.push(handle.streamId);
  }

  async cancel(handle: AsrStreamHandle): Promise<void> {
    this.cancelledStreams.push(handle.streamId);
  }

  emitStarted(streamId: string): void {
    this.deliver({ type: 'asr.started', streamId });
  }

  emitPartial(streamId: string, transcript: string, sequence: number): void {
    this.deliver({ type: 'asr.partial', streamId, transcript, sequence });
  }

  emitFinal(streamId: string, transcript: string, sequence: number): void {
    this.deliver({ type: 'asr.final', streamId, transcript, sequence });
  }

  emitError(
    streamId: string,
    code: string,
    retryable: boolean,
    safeMessage: string,
  ): void {
    this.deliver({ type: 'asr.error', streamId, code, retryable, safeMessage });
  }

  emitCancelled(streamId: string): void {
    this.deliver({ type: 'asr.cancelled', streamId });
  }

  emitClosed(streamId: string): void {
    this.deliver({ type: 'asr.closed', streamId });
  }

  private deliver(event: AsrEvent): void {
    this.emitters.get(event.streamId)?.(event);
  }
}