import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/persistent_command_coordinator.dart';
import 'package:claude_remote/data/agent_socket.dart' show JsonMap;
import 'package:claude_remote/features/chat/prompt_command_coordinator.dart';
import 'package:claude_remote/protocol/s02_messages.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();

  test('decode failure still clears the persisted execution intent', () async {
    final dir = await Directory.systemTemp.createTemp('s04-chat-decode-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await RecoveryStore.open(
      factory: databaseFactoryFfi,
      supportDirectory: () async => dir,
    );
    addTearDown(store.close);
    final persistent = PersistentCommandCoordinator(
      outbox: store.outbox,
      deliver: (snapshot) async => JsonMap.from({'runId': 'run_1'}),
      schedule: (duration, callback) => () {},
    );
    final coordinator = PromptCommandCoordinator(
      client: CommandClient(),
      persistent: persistent,
    );
    final request = CommandRequest<PromptAccepted>(
      commandId: 'cmd_decode',
      traceId: 'trace_decode',
      type: 'prompt.send',
      sessionId: 's1',
      payload: const {'text': 'hello'},
      decode: (data) {
        throw const CommandFailure('INVALID_RESPONSE');
      },
    );

    await expectLater(
      coordinator.send(request),
      throwsA(isA<CommandFailure>()),
    );
    final row = await store.outbox.find('cmd_decode');
    expect(row?.payloadJson, isNull);
    expect(row?.state.name, 'completed');
    expect(await persistent.canStartExecutionIntent('s1'), isTrue);
    expect(jsonEncode(const {'text': 'hello'}).isNotEmpty, isTrue);
  });
}
