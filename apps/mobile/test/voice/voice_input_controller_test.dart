import 'dart:async';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart';

import 'package:claude_remote/voice/voice_asr_client.dart';
import 'package:claude_remote/voice/voice_audio_capture.dart';
import 'package:claude_remote/voice/voice_draft.dart';
import 'package:claude_remote/voice/voice_draft_repository.dart';
import 'package:claude_remote/voice/voice_input_controller.dart';
import 'package:claude_remote/voice/voice_ui_state.dart';

class FakeConnection implements VoiceAsrConnection {
  final StreamController<AsrServerEvent> controller =
      StreamController<AsrServerEvent>.broadcast();
  final List<String> starts = [];
  final List<Uint8List> audio = [];
  int finishes = 0;
  int cancels = 0;
  int closes = 0;

  @override
  Stream<AsrServerEvent> get events => controller.stream;

  @override
  Future<void> sendStart({required String asrStreamId}) async {
    starts.add(asrStreamId);
  }

  @override
  void sendAudio(Uint8List pcm) => audio.add(pcm);

  @override
  void sendFinish() => finishes += 1;

  @override
  void sendCancel() => cancels += 1;

  @override
  Future<void> close() async => closes += 1;

  void emit(AsrServerEvent event) => controller.add(event);
}

class FakeFactory implements VoiceAsrClientFactory {
  FakeFactory(this.connection);
  final FakeConnection connection;
  int connects = 0;
  bool failConnect = false;

  @override
  Future<VoiceAsrConnection> connect() async {
    connects += 1;
    if (failConnect) throw const VoiceAsrConnectionException('failed');
    return connection;
  }
}

class FakeCapture implements VoiceAudioCapture {
  bool permission = true;
  bool failStart = false;
  int starts = 0;
  int stops = 0;
  int disposals = 0;
  final StreamController<Uint8List> controller =
      StreamController<Uint8List>.broadcast();

  @override
  Future<bool> hasPermission() async => permission;

  @override
  Future<Stream<Uint8List>> start() async {
    starts += 1;
    if (failStart) throw StateError('mic unavailable');
    return controller.stream;
  }

  @override
  Future<void> stop() async => stops += 1;

  @override
  Future<void> dispose() async => disposals += 1;
}

class Committed {
  const Committed({required this.finalText, required this.combined});
  final String finalText;
  final String combined;
}

class FakeDrafts implements VoiceDraftStore {
  bool conflict = false;
  final List<Committed> committed = [];
  final List<String> updates = [];
  final List<String> restored = [];

  @override
  Future<VoiceDraft> commitFinal({
    required String voiceDraftId,
    required String asrStreamId,
    required String originSessionId,
    required String originalDraft,
    required String finalText,
  }) async {
    if (conflict) throw const VoiceDraftConflict();
    final combined =
        originalDraft.isEmpty ? finalText : '$originalDraft\n$finalText';
    committed.add(Committed(finalText: finalText, combined: combined));
    return VoiceDraft(
      voiceDraftId: voiceDraftId,
      asrStreamId: asrStreamId,
      originSessionId: originSessionId,
      originalDraft: originalDraft,
      combinedDraft: combined,
      status: 'pending',
      createdAt: DateTime.fromMillisecondsSinceEpoch(0),
    );
  }

  @override
  Future<VoiceDraft> updateCombinedDraft(
    String voiceDraftId,
    String combinedDraft,
  ) async {
    updates.add(combinedDraft);
    return VoiceDraft(
      voiceDraftId: voiceDraftId,
      asrStreamId: 'asr_1',
      originSessionId: 'session_1',
      originalDraft: '',
      combinedDraft: combinedDraft,
      status: 'pending',
      createdAt: DateTime.fromMillisecondsSinceEpoch(0),
    );
  }

  @override
  Future<void> restoreOriginal(String voiceDraftId) async {
    restored.add(voiceDraftId);
  }

  @override
  Future<void> deleteWithin(Transaction txn, String voiceDraftId) async {}
}

class FakeAccess implements VoiceDraftAccess {
  FakeAccess({this.selected = 'session_1', Map<String, String>? drafts})
    : drafts = drafts ?? {'session_1': '原草稿'};

  String selected;
  final Map<String, String> drafts;
  final List<String> errors = [];

  @override
  String get selectedSessionId => selected;

  @override
  String draftOf(String sessionId) => drafts[sessionId] ?? '';

  @override
  void setDraft(String sessionId, String text) {
    drafts[sessionId] = text;
  }

  @override
  void showVoiceError(String code, String safeMessage) {
    errors.add(code);
  }
}

class Harness {
  Harness() {
    factory = FakeFactory(connection);
    controller = VoiceInputController(
      clientFactory: factory,
      capture: capture,
      drafts: drafts,
      access: access,
    );
    addTearDown(controller.dispose);
  }

  final FakeConnection connection = FakeConnection();
  final FakeCapture capture = FakeCapture();
  final FakeDrafts drafts = FakeDrafts();
  final FakeAccess access = FakeAccess();
  late final FakeFactory factory;
  late final VoiceInputController controller;

  Future<void> press(WidgetTester tester) async {
    unawaited(controller.press());
    await tester.pump();
    await tester.pump();
  }

  void started() {
    connection.emit(const AsrStarted(asrStreamId: 'asr_1'));
  }

  void partial(int sequence, String text) {
    connection.emit(
      AsrPartial(asrStreamId: 'asr_1', sequence: sequence, text: text),
    );
  }

  void finalText(int sequence, String text) {
    connection.emit(
      AsrFinal(asrStreamId: 'asr_1', sequence: sequence, text: text),
    );
  }
}

void main() {
  Future<void> settle(WidgetTester tester) async {
    for (var index = 0; index < 6; index += 1) {
      await tester.pump();
    }
  }

  testWidgets('denies recording when microphone permission is refused', (
    tester,
  ) async {
    final h = Harness()..capture.permission = false;
    await h.press(tester);
    expect(h.controller.state, isA<VoiceErrorState>());
    expect((h.controller.state as VoiceErrorState).code, 'ASR_PERMISSION_DENIED');
    expect(h.capture.starts, 0);
    expect(h.factory.connects, 0);
  });

  testWidgets('reports ASR_MIC_UNAVAILABLE when capture fails', (
    tester,
  ) async {
    final h = Harness()..capture.failStart = true;
    await h.press(tester);
    h.started();
    await settle(tester);
    expect((h.controller.state as VoiceErrorState).code, 'ASR_MIC_UNAVAILABLE');
  });

  testWidgets('release while connecting cancels without capture or finalize', (
    tester,
  ) async {
    final h = Harness();
    await h.press(tester);
    unawaited(h.controller.release());
    await settle(tester);
    expect(h.controller.state, isA<VoiceIdle>());
    expect(h.connection.cancels, 1);
    expect(h.connection.finishes, 0);
    expect(h.capture.starts, 0);
  });

  testWidgets('ignores a started event that arrives after release', (
    tester,
  ) async {
    final h = Harness();
    await h.press(tester);
    unawaited(h.controller.release());
    await settle(tester);
    h.started();
    await settle(tester);
    expect(h.capture.starts, 0);
    expect(h.controller.state, isA<VoiceIdle>());
  });

  testWidgets('records, replaces partials and commits the final draft', (
    tester,
  ) async {
    final h = Harness();
    await h.press(tester);
    h.started();
    await tester.pump();
    expect(h.controller.state, isA<VoiceRecording>());

    h.capture.controller.add(Uint8List.fromList([0, 0, 0, 0]));
    await tester.pump();
    h.partial(1, '你');
    await tester.pump();
    h.partial(2, '你好');
    await tester.pump();
    final recording = h.controller.state as VoiceRecording;
    expect(recording.partialText, '你好');

    unawaited(h.controller.release());
    await settle(tester);
    expect(h.controller.state, isA<VoiceFinalizing>());
    expect(h.connection.finishes, 1);

    h.finalText(3, '你好，世界。');
    await settle(tester);
    expect(h.controller.state, isA<VoiceIdle>());
    expect(h.drafts.committed.single.finalText, '你好，世界。');
    expect(h.access.drafts['session_1'], '原草稿\n你好，世界。');
    expect(h.access.selected, 'session_1');
  });

  testWidgets('drops a late final after cancel', (tester) async {
    final h = Harness();
    await h.press(tester);
    h.started();
    await tester.pump();
    unawaited(h.controller.cancel(VoiceCancelReason.user));
    await settle(tester);
    h.finalText(1, '迟到');
    await settle(tester);
    expect(h.drafts.committed, isEmpty);
    expect(h.controller.state, isA<VoiceIdle>());
  });

  testWidgets('ignores stale partial sequences', (tester) async {
    final h = Harness();
    await h.press(tester);
    h.started();
    await tester.pump();
    h.partial(3, '新');
    await tester.pump();
    h.partial(2, '旧');
    await tester.pump();
    expect((h.controller.state as VoiceRecording).partialText, '新');
    unawaited(h.controller.cancel(VoiceCancelReason.user));
    await settle(tester);
  });

  testWidgets('auto-finishes at the 60 second limit', (tester) async {
    final h = Harness();
    await h.press(tester);
    h.started();
    await tester.pump();
    await tester.pump(const Duration(seconds: 60));
    await settle(tester);
    expect(h.connection.finishes, 1);
    expect(h.controller.state, isA<VoiceFinalizing>());
  });

  testWidgets('maps a closed socket to a safe error', (tester) async {
    final h = Harness();
    await h.press(tester);
    h.started();
    await tester.pump();
    h.connection.emit(
      const AsrClosed(asrStreamId: 'asr_1', reason: 'socket_closed'),
    );
    await settle(tester);
    expect(
      (h.controller.state as VoiceErrorState).code,
      'ASR_CONNECTION_FAILED',
    );
  });

  testWidgets('maps provider errors to safe states', (tester) async {
    final h = Harness();
    await h.press(tester);
    h.started();
    await tester.pump();
    h.connection.emit(
      const AsrServerError(
        asrStreamId: 'asr_1',
        code: 'ASR_FINAL_TIMEOUT',
        retryable: true,
        safeMessage: 'ASR_FINAL_TIMEOUT',
      ),
    );
    await settle(tester);
    expect((h.controller.state as VoiceErrorState).code, 'ASR_FINAL_TIMEOUT');
    expect(h.access.errors, contains('ASR_FINAL_TIMEOUT'));
  });

  testWidgets('surfaces a draft conflict without overwriting', (tester) async {
    final h = Harness()..drafts.conflict = true;
    await h.press(tester);
    h.started();
    await tester.pump();
    unawaited(h.controller.release());
    await settle(tester);
    h.finalText(1, '识别文本');
    await settle(tester);
    expect((h.controller.state as VoiceErrorState).code, 'ASR_DRAFT_CONFLICT');
    expect(h.access.drafts['session_1'], '原草稿');
  });

  testWidgets('fails safely when the audio socket cannot connect', (
    tester,
  ) async {
    final h = Harness()..factory.failConnect = true;
    await h.press(tester);
    expect(
      (h.controller.state as VoiceErrorState).code,
      'ASR_CONNECTION_FAILED',
    );
  });

  testWidgets('interruption shows ASR_INTERRUPTED', (tester) async {
    final h = Harness();
    await h.press(tester);
    h.started();
    await tester.pump();
    unawaited(h.controller.cancel(VoiceCancelReason.interruption));
    await settle(tester);
    expect((h.controller.state as VoiceErrorState).code, 'ASR_INTERRUPTED');
    expect(h.connection.cancels, 1);
  });

  testWidgets('persists edits and can restore the original draft', (
    tester,
  ) async {
    final h = Harness();
    await h.press(tester);
    h.started();
    await tester.pump();
    unawaited(h.controller.release());
    await settle(tester);
    h.finalText(1, '识别文本。');
    await settle(tester);

    unawaited(h.controller.updateCombinedDraft('识别文本，编辑。'));
    await settle(tester);
    expect(h.drafts.updates, ['识别文本，编辑。']);
    expect(h.access.drafts['session_1'], '识别文本，编辑。');

    unawaited(h.controller.discardVoiceDraft());
    await settle(tester);
    expect(h.drafts.restored, ['vd_1']);
    expect(h.access.drafts['session_1'], '原草稿');
  });
}