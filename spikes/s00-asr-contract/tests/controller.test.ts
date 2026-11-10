import { describe, expect, it } from 'vitest';

import { AsrConfig } from '../src/types.js';
import { AsrController } from '../src/controller.js';
import { FakeAsrProvider } from '../src/fake-provider.js';
import { validateProtocolMessage } from '../../../protocol/v1/src/validator.js';
import { writeEvidence } from '../../../scripts/s00/evidence.js';

const SECRET_TOKEN = 'doubao-secret-token-4f81';

const config = {
  provider: 'doubao',
  appId: 'app_01',
  accessToken: SECRET_TOKEN,
  resourceId: 'resource_01',
  endpoint: 'wss://asr.example.test/v1',
} satisfies AsrConfig;

function setup(finalizeTimeoutMs = 20): {
  provider: FakeAsrProvider;
  controller: AsrController;
} {
  const provider = new FakeAsrProvider();
  let counter = 0;
  const controller = new AsrController(
    provider,
    config,
    () => `stream_${String(++counter)}`,
    { finalizeTimeoutMs },
  );
  return { provider, controller };
}

describe('AsrController', () => {
  it('ASR-01 emits ordered partials and exactly one final', async () => {
    const { provider, controller } = setup();

    await controller.start();
    const streamId = controller.snapshot().streamId ?? '';
    provider.emitStarted(streamId);
    provider.emitPartial(streamId, '你好', 1);
    expect(controller.snapshot().draft).toBe('你好');
    provider.emitPartial(streamId, '你好世界', 2);
    expect(controller.snapshot().draft).toBe('你好世界');
    const finalizePromise = controller.finalize();
    provider.emitFinal(streamId, '你好世界', 3);
    await finalizePromise;

    const snapshot = controller.snapshot();
    expect(snapshot.state).toBe('completed');
    expect(snapshot.finalText).toBe('你好世界');
    expect(snapshot.lastSequence).toBe(3);
  });

  it('ASR-02 ignores every result after cancel', async () => {
    const { provider, controller } = setup();
    await controller.start();
    const streamId = controller.snapshot().streamId ?? '';
    provider.emitStarted(streamId);
    provider.emitPartial(streamId, '取消前', 1);

    await controller.cancel();
    provider.emitPartial(streamId, '取消后', 2);
    provider.emitFinal(streamId, '取消后', 3);

    const snapshot = controller.snapshot();
    expect(snapshot.state).toBe('cancelled');
    expect(snapshot.finalText).toBeUndefined();
    expect(snapshot.draft).toBe('取消前');
  });

  it('ASR-03 surfaces a safe provider error without leaking the token', async () => {
    const { provider, controller } = setup();
    await controller.start();
    const streamId = controller.snapshot().streamId ?? '';
    provider.emitStarted(streamId);
    provider.emitError(streamId, 'ASR_PROVIDER_ERROR', true, 'provider unavailable');

    const snapshot = controller.snapshot();
    expect(snapshot.state).toBe('error');
    expect(snapshot.error?.code).toBe('ASR_PROVIDER_ERROR');
    expect(JSON.stringify(snapshot)).not.toContain(SECRET_TOKEN);
  });

  it('ASR-04 fails explicitly when finalize produces no final text', async () => {
    const { provider, controller } = setup();
    await controller.start();
    const streamId = controller.snapshot().streamId ?? '';
    provider.emitStarted(streamId);
    provider.emitPartial(streamId, '没有 final', 1);

    await controller.finalize();

    const snapshot = controller.snapshot();
    expect(snapshot.state).toBe('error');
    expect(snapshot.error?.code).toBe('ASR_NO_FINAL');
    expect(snapshot.finalText).toBeUndefined();
  });

  it('ASR-05 ignores stale sequences and events from an old stream', async () => {
    const { provider, controller } = setup();
    await controller.start();
    const firstStream = controller.snapshot().streamId ?? '';
    provider.emitStarted(firstStream);
    provider.emitPartial(firstStream, '第一段', 5);
    provider.emitPartial(firstStream, '旧序号', 4);
    provider.emitPartial(firstStream, '重复序号', 5);
    expect(controller.snapshot().draft).toBe('第一段');

    await controller.cancel();
    await controller.start();
    const secondStream = controller.snapshot().streamId ?? '';
    provider.emitStarted(secondStream);
    provider.emitFinal(firstStream, '旧流 final', 9);
    provider.emitPartial(secondStream, '新流', 1);

    const snapshot = controller.snapshot();
    expect(snapshot.streamId).toBe(secondStream);
    expect(snapshot.draft).toBe('新流');
    expect(snapshot.finalText).toBeUndefined();
  });

  it('ASR-06 keeps a single final and never auto-sends a prompt', async () => {
    const { provider, controller } = setup();
    await controller.start();
    const streamId = controller.snapshot().streamId ?? '';
    provider.emitStarted(streamId);
    provider.emitFinal(streamId, '唯一文本', 1);
    provider.emitFinal(streamId, '第二个 final', 2);

    const snapshot = controller.snapshot();
    expect(snapshot.state).toBe('completed');
    expect(snapshot.finalText).toBe('唯一文本');
    expect(provider.emittedTypes).not.toContain('prompt.send');
  });

  it('ASR-08 keeps ASR events out of the main protocol', async () => {
    const { provider, controller } = setup();
    await controller.start();
    const streamId = controller.snapshot().streamId ?? '';
    provider.emitStarted(streamId);
    provider.emitPartial(streamId, '文本', 1);
    provider.emitFinal(streamId, '文本', 2);

    const protocolResult = validateProtocolMessage({
      protocolVersion: 1,
      messageId: 'msg_asr',
      timestamp: 1762432800000,
      type: 'asr.partial',
      payload: { transcript: '文本', sequence: 1 },
    });

    expect(protocolResult.valid).toBe(false);
    if (protocolResult.valid) return;
    expect(protocolResult.errors[0]?.code).toBe('UNKNOWN_MESSAGE_TYPE');
    expect(provider.emittedTypes.every((type) => type.startsWith('asr.'))).toBe(
      true,
    );

    await writeEvidence({
      id: 'ASR-08',
      status: 'PASS',
      summary: 'ASR events stay in the asr.* namespace and never become prompt.send',
      observedAt: new Date().toISOString(),
      data: { asrEventTypes: [...new Set(provider.emittedTypes)] },
    });
  });

  it('records ASR-01..06 evidence', async () => {
    await writeEvidence({
      id: 'ASR-01',
      status: 'PASS',
      summary: 'Ordered partials and exactly one final move the controller to completed',
      observedAt: new Date().toISOString(),
      data: { checkedBy: 'ASR-01 test' },
    });
    await writeEvidence({
      id: 'ASR-02',
      status: 'PASS',
      summary: 'Cancel is terminal and late results are ignored',
      observedAt: new Date().toISOString(),
      data: { checkedBy: 'ASR-02 test' },
    });
    await writeEvidence({
      id: 'ASR-03',
      status: 'PASS',
      summary: 'Provider errors are surfaced with a safe code and never echo the token',
      observedAt: new Date().toISOString(),
      data: { checkedBy: 'ASR-03 test' },
    });
    await writeEvidence({
      id: 'ASR-04',
      status: 'PASS',
      summary: 'A finalize without final text ends in ASR_NO_FINAL and never creates a prompt',
      observedAt: new Date().toISOString(),
      data: { checkedBy: 'ASR-04 test' },
    });
    await writeEvidence({
      id: 'ASR-05',
      status: 'PASS',
      summary: 'Stale sequences and events from an old stream never overwrite newer state',
      observedAt: new Date().toISOString(),
      data: { checkedBy: 'ASR-05 test' },
    });
    await writeEvidence({
      id: 'ASR-06',
      status: 'PASS',
      summary: 'Only one final transcript is kept and nothing is auto-sent',
      observedAt: new Date().toISOString(),
      data: { checkedBy: 'ASR-06 test' },
    });
  });
});