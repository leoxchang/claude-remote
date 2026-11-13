import 'dart:async';
import 'dart:io';

import 'package:claude_remote/connection/command_client.dart';
import 'package:claude_remote/connection/persistent_command_coordinator.dart';
import 'package:claude_remote/data/agent_socket.dart' show JsonMap;
import 'package:claude_remote/recovery/outbox_command.dart';
import 'package:claude_remote/recovery/outbox_repository.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfi;

  Future<RecoveryStore> openStore(Directory dir) {
    return RecoveryStore.open(
      factory: factory,
      supportDirectory: () async => dir,
    );
  }

  test('persists before sending and retries with the same commandId', () async {
    final dir = await Directory.systemTemp.createTemp('s04-coordinator-send-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    final deliveries = <PersistedCommandSnapshot>[];
    final retried = Completer<void>();
    var fail = true;
    final scheduled = <void Function()>[];
    final coordinator = PersistentCommandCoordinator(
      outbox: store.outbox,
      deliver: (snapshot) async {
        deliveries.add(snapshot);
        expect(await store.outbox.find(snapshot.commandId), isNotNull);
        if (fail) {
          fail = false;
          throw const CommandTimeout('cmd_1');
        }
        if (!retried.isCompleted) retried.complete();
        return JsonMap.from({'sessionId': 's1', 'runId': 'run_1', 'status': 'queued'});
      },
      schedule: (duration, callback) {
        scheduled.add(callback);
        return () => scheduled.clear();
      },
    );
    await coordinator.onReady('agent_1');

    await expectLater(
      coordinator.send(
        commandId: 'cmd_1',
        sessionId: 's1',
        type: 'prompt.send',
        payload: const {'text': 'hello'},
      ),
      throwsA(isA<CommandTimeout>()),
    );
    expect(deliveries, hasLength(1));
    expect(
      (await store.outbox.find('cmd_1'))?.state,
      OutboxState.persisted,
    );
    expect(scheduled, hasLength(1));

    scheduled.removeLast()();
    await retried.future.timeout(const Duration(seconds: 2));
    expect(deliveries, hasLength(2));
    expect(deliveries.last.commandId, 'cmd_1');
    expect(deliveries.last.payload, const {'text': 'hello'});

    await coordinator.onConfirmed('cmd_1');
    expect((await store.outbox.find('cmd_1'))?.payloadJson, isNull);
  });

  test('requires confirmation after the agent instance changes', () async {
    final dir = await Directory.systemTemp.createTemp('s04-coordinator-agent-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    final sent = <String>[];
    final coordinator = PersistentCommandCoordinator(
      outbox: store.outbox,
      deliver: (snapshot) async {
        sent.add(snapshot.commandId);
        if (sent.length == 1) throw const CommandTimeout('cmd_1');
        return JsonMap.from({'runId': 'run_1', 'status': 'queued'});
      },
      schedule: (duration, callback) => () {},
    );
    await coordinator.onReady('agent_old');
    await expectLater(
      coordinator.send(
        commandId: 'cmd_1',
        sessionId: 's1',
        type: 'prompt.send',
        payload: const {'text': 'hello'},
      ),
      throwsA(isA<CommandTimeout>()),
    );
    expect(sent, ['cmd_1']);

    await coordinator.onReady('agent_new');
    expect(
      (await store.outbox.find('cmd_1'))?.state,
      OutboxState.confirmationRequired,
    );
    expect(await coordinator.canStartExecutionIntent('s1'), isFalse);
    await expectLater(
      coordinator.send(
        commandId: 'cmd_1',
        sessionId: 's1',
        type: 'prompt.send',
        payload: const {'text': 'hello'},
      ),
      throwsA(isA<CommandFailure>()),
    );

    await coordinator.confirmRetry('cmd_1');
    expect(sent, ['cmd_1', 'cmd_1']);
    await coordinator.onConfirmed('cmd_1');
    expect(await coordinator.canStartExecutionIntent('s1'), isTrue);
  });

  test('redelivers awaiting_ack after relaunch and releases the gate', () async {
    final dir = await Directory.systemTemp.createTemp('s04-coordinator-ack-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);
    await store.outbox.insert(
      OutboxCommand(
        commandId: 'cmd_ack',
        sessionId: 's1',
        type: 'prompt.send',
        payloadJson: '{"text":"hello"}',
        agentInstanceId: 'agent_1',
        state: OutboxState.awaitingAck,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
    final deliveries = <String>[];
    final coordinator = PersistentCommandCoordinator(
      outbox: store.outbox,
      deliver: (snapshot) async {
        deliveries.add(snapshot.commandId);
        return JsonMap.from({'runId': 'run_1', 'status': 'queued'});
      },
      schedule: (duration, callback) => () {},
    );
    await coordinator.onReady('agent_1');
    expect(deliveries, ['cmd_ack']);
    expect(await coordinator.canStartExecutionIntent('s1'), isFalse);
    await coordinator.onConfirmed('cmd_ack');
    expect(await coordinator.canStartExecutionIntent('s1'), isTrue);
  });

  test('discarding a confirmation tombstone allows new intent', () async {
    final dir = await Directory.systemTemp.createTemp('s04-coordinator-discard-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);
    final coordinator = PersistentCommandCoordinator(
      outbox: store.outbox,
      deliver: (snapshot) async {
        throw const CommandTimeout('cmd_1');
      },
      schedule: (duration, callback) => () {},
    );
    await coordinator.onReady('agent_old');
    await expectLater(
      coordinator.send(
        commandId: 'cmd_1',
        sessionId: 's1',
        type: 'prompt.send',
        payload: const {'text': 'hello'},
      ),
      throwsA(isA<CommandTimeout>()),
    );
    await coordinator.onReady('agent_new');
    await coordinator.discardUnknown('cmd_1');
    expect((await store.outbox.find('cmd_1'))?.state, OutboxState.discarded);
    expect(await coordinator.canStartExecutionIntent('s1'), isTrue);
  });

  test('gates one execution intent per session for prompt and requeue only',
      () async {
    final dir = await Directory.systemTemp.createTemp('s04-coordinator-gate-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);
    final coordinator = PersistentCommandCoordinator(
      outbox: store.outbox,
      deliver: (snapshot) async {
        throw const CommandTimeout('offline');
      },
      schedule: (duration, callback) => () {},
    );
    await coordinator.onReady('agent_1');
    await expectLater(
      coordinator.send(
        commandId: 'cmd_1',
        sessionId: 's1',
        type: 'prompt.send',
        payload: const {'text': 'one'},
      ),
      throwsA(isA<CommandTimeout>()),
    );
    await expectLater(
      coordinator.send(
        commandId: 'cmd_2',
        sessionId: 's1',
        type: 'run.requeue',
        payload: const {'expectedRecoveryGeneration': 1},
      ),
      throwsA(isA<CommandFailure>()),
    );
    expect(
      (await store.outbox.find('cmd_2')),
      isNull,
    );
    // 其他 session 与只读命令不受门控。
    await expectLater(
      coordinator.send(
        commandId: 'cmd_3',
        sessionId: 's2',
        type: 'prompt.send',
        payload: const {'text': 'two'},
      ),
      throwsA(isA<CommandTimeout>()),
    );
    await expectLater(
      coordinator.send(
        commandId: 'cmd_4',
        sessionId: 's1',
        type: 'session.sync',
        payload: const {'afterSeq': 0},
      ),
      throwsA(isA<CommandTimeout>()),
    );
    expect(await store.outbox.find('cmd_4'), isNotNull);
  });
}
