import 'dart:io';

import 'package:claude_remote/domain/session.dart';
import 'package:claude_remote/protocol/decoder.dart';
import 'package:claude_remote/protocol/envelope.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:flutter_test/flutter_test.dart';

const examplesDir = '../../protocol/v1/examples/s02';

String readExample(String name) =>
    File('$examplesDir/$name').readAsStringSync();

void main() {
  test('decodes every shared S02 example', () {
    final files = Directory(examplesDir)
        .listSync()
        .whereType<File>()
        .where((file) => file.path.endsWith('.json'))
        .toList();
    expect(files, isNotEmpty);

    for (final file in files) {
      final message = ProtocolDecoder.decode(file.readAsStringSync());
      expect(message.type, isNotEmpty);
    }
  });

  test('decodes S02 commands into command messages', () {
    final workspaceList = ProtocolDecoder.decode(readExample('workspace-list.json'));
    expect(workspaceList, isA<CommandMessage>());
    expect(workspaceList.type, 'workspace.list');

    final sessionList = ProtocolDecoder.decode(readExample('session-list-page.json'));
    expect(sessionList, isA<CommandMessage>());
    expect((sessionList as CommandMessage).payload['workspaceId'], 'ws_alpha');

    final queueRemove = ProtocolDecoder.decode(readExample('queue-remove.json'));
    expect(queueRemove, isA<CommandMessage>());
    expect((queueRemove as CommandMessage).runId, 'run_alpha');
  });

  test('decodes run events as timeline events', () {
    final queued = ProtocolDecoder.decode(readExample('run-queued.json'));
    expect(queued, isA<TimelineEvent>());
    expect((queued as TimelineEvent).type, 'run.queued');
    expect(queued.runId, 'run_alpha');
    expect(queued.payload['enqueuedAt'], isA<int>());

    final started = ProtocolDecoder.decode(readExample('run-started.json'));
    expect(started, isA<TimelineEvent>());
    expect((started as TimelineEvent).payload['status'], 'starting');
  });

  test('decodes the S02 snapshot payload with queue and capacity', () {
    final snapshot = ProtocolDecoder.decode(
      readExample('session-snapshot.json'),
    );
    expect(snapshot, isA<ControlMessage>());
    final parsed = SessionSnapshot.fromPayload(
      (snapshot as ControlMessage).payload,
    );

    expect(parsed.sessionId, 'session_alpha');
    expect(parsed.workspaceId, 'ws_alpha');
    expect(parsed.title, '会话 2026-11-08 10:00');
    expect(parsed.queuedRuns, hasLength(1));
    expect(parsed.queuedRuns.first.runId, 'run_alpha');
    expect(parsed.globalCapacity?.activeRunCount, 1);
    expect(parsed.globalCapacity?.maxActiveRuns, 2);
  });

  test('keeps the documented error codes in the error examples', () {
    final conflict = ProtocolDecoder.decode(
      readExample('command-id-conflict.json'),
    );
    final cursor = ProtocolDecoder.decode(readExample('invalid-cursor.json'));

    expect((conflict as CommandResultMessage).errorCode, 'COMMAND_ID_CONFLICT');
    expect((cursor as CommandResultMessage).errorCode, 'INVALID_CURSOR');
  });

  test('rejects unknown S02 types', () {
    expect(
      () => ProtocolDecoder.decode(
        '{"protocolVersion":1,"messageId":"m","timestamp":0,'
        '"type":"session.future.type","payload":{}}',
      ),
      throwsA(
        isA<ProtocolDecodeException>().having(
          (error) => error.code,
          'code',
          'UNKNOWN_MESSAGE_TYPE',
        ),
      ),
    );
  });
}