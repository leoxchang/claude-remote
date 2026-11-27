import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/connection/chat_session_runtime.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/data/providers.dart';
import 'package:claude_remote/data/recovery_providers.dart';
import 'package:claude_remote/features/chat/chat_controller.dart';
import 'package:claude_remote/recovery/cache_repository.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../connection/fake_socket.dart';

const DeviceCredential credential = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_1',
  baseUrl: 'http://127.0.0.1:8787',
);

/// 旧版缓存行：信封只有四类字段，eventId/sessionId/seq 只在列里。
Map<String, Object?> legacyEvent(String type, Map<String, Object?> payload) {
  return {
    'protocolVersion': 1,
    'messageId': 'msg_$type',
    'timestamp': 1762432800000,
    'type': type,
    'payload': payload,
  };
}

void main() {
  sqfliteFfiInit();

  late RecoveryStore store;
  late FakeAgentSocket controlSocket;
  late FakeAgentSocket commandSocket;
  late ProviderContainer container;
  ChatSessionRuntime? runtime;

  setUp(() async {
    final dir = await Directory.systemTemp.createTemp('chat-restore-');
    addTearDown(() => dir.delete(recursive: true));
    store = await RecoveryStore.open(
      factory: databaseFactoryFfi,
      supportDirectory: () async => dir,
    );
    addTearDown(store.close);
    controlSocket = FakeAgentSocket();
    commandSocket = FakeAgentSocket();
    container = ProviderContainer(
      overrides: [
        credentialProvider.overrideWith((ref) async => credential),
        recoveryStoreProvider.overrideWith((ref) async => store),
        readyAgentSocketProvider.overrideWithValue(
          (credential) async => commandSocket,
        ),
        controlSocketProvider.overrideWithValue((credential) => controlSocket),
      ],
    );
  });

  tearDown(() async {
    // 先拆运行时再关连接，避免容器销毁顺序引发重复 dispose。
    await runtime?.dispose();
    await commandSocket.close();
    await controlSocket.close();
  });

  test('冷启动回放旧版缓存后，聊天时间线仍有助手回复', () async {    await store.cache.putEvents('session_01', [
      CachedEvent(
        eventId: 'event_1',
        sessionId: 'session_01',
        seq: 1,
        payloadJson: jsonEncode(
          legacyEvent('message.delta', const {
            'assistantMessageId': 'msg_a',
            'text': '你好',
            'index': 1,
            'deltaSeq': 1,
          }),
        ),
        cachedAt: 1,
      ),
      CachedEvent(
        eventId: 'event_2',
        sessionId: 'session_01',
        seq: 2,
        payloadJson: jsonEncode(
          legacyEvent('message.completed', const {
            'assistantMessageId': 'msg_a',
            'text': '你好，需要我做什么？',
            'content': [
              {'type': 'text', 'text': '你好，需要我做什么？'},
            ],
          }),
        ),
        cachedAt: 1,
      ),
    ]);
    await store.writeCursor(sessionId: 'session_01', lastContiguousSeq: 2);

    runtime = await container.read(chatSessionRuntimeProvider.future);
    expect(runtime, isNotNull);

    final started = runtime!.start();
    await _answerCommands(controlSocket, started);
    await started;
    await pumpEventQueue();

    final state = container.read(chatControllerProvider);
    final messages = state.timeline?.messages ?? const [];
    expect(messages, hasLength(1));
    expect(messages.single.text, '你好，需要我做什么？');
    expect(state.timeline?.lastSeq, 2);
    expect(state.error, isNull);
  });

  test('缓存不可解码时清空缓存并把持久游标归零，避免下次跳过历史', () async {
    await store.cache.putEvents('session_01', [
      CachedEvent(
        eventId: 'event_1',
        sessionId: 'session_01',
        seq: 1,
        payloadJson: '{"broken"',
        cachedAt: 1,
      ),
    ]);
    await store.writeCursor(sessionId: 'session_01', lastContiguousSeq: 2);

    runtime = await container.read(chatSessionRuntimeProvider.future);
    expect(runtime, isNotNull);
    final started = runtime!.start();
    await _answerCommands(controlSocket, started, failSync: true);
    await started;
    await pumpEventQueue();

    expect(await store.cache.readEvents('session_01'), isEmpty);
    expect(
      (await store.readCursor('session_01'))?.lastContiguousSeq,
      0,
      reason: '残留游标会让下一次冷启动从中间开始，永远取不回历史',
    );
  });
}

/// 应答握手与 onReady 发出的命令，直到 [started] 结束。
Future<void> _answerCommands(
  FakeAgentSocket socket,
  Future<void> started, {
  bool failSync = false,
}) async {
  var answered = 0;
  var finished = false;
  started.then<void>(
    (_) => finished = true,
    onError: (Object _) => finished = true,
  );
  for (var round = 0; round < 500 && !finished; round += 1) {
    await pumpEventQueue();
    while (answered < socket.sent.length) {
      final raw = socket.sent[answered];
      answered += 1;
      final message = jsonDecode(raw) as Map<String, dynamic>;
      final type = message['type'];
      if (type == 'connection.hello') {
        socket.emitMessage(readyMessage());
        continue;
      }
      final commandId = message['commandId'] as String;
      socket.emitMessage(_resultFor(type as String, commandId, failSync));
    }
  }
}

Map<String, Object?> _resultFor(
  String type,
  String commandId,
  bool failSync,
) {
  if (type == 'session.sync' && failSync) {
    return commandResult(
      commandId: commandId,
      status: 'error',
      error: const {
        'code': 'SYNC_FAILED',
        'message': 'sync failed',
        'retryable': true,
      },
    );
  }
  final data = switch (type) {
    'session.start' => <String, Object?>{
      'sessionId': 'session_01',
      'claudeSessionId': 'claude_01',
    },
    'session.sync' => <String, Object?>{
      'events': const <Object?>[],
      'nextAfterSeq': 2,
      'lastSeq': 2,
      'hasMore': false,
    },
    'session.snapshot' => <String, Object?>{
      'snapshotId': 'snap_1',
      'sessionId': 'session_01',
      'lastSeq': 2,
      'pageIndex': 0,
      'pageCount': 1,
      'byteLength': 0,
      'sha256': '0' * 64,
      'payload': <String, Object?>{'recoveryRequiredRuns': const <Object?>[]},
    },
    _ => <String, Object?>{},
  };
  return commandResult(commandId: commandId, data: data);
}
