import 'dart:io';

import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:claude_remote/data/recovery_providers.dart';
import 'package:claude_remote/features/pairing/pairing_controller.dart';
import 'package:claude_remote/recovery/outbox_repository.dart';
import 'package:claude_remote/recovery/recovery_database.dart';
import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import '../../features/approvals/approval_test_support.dart' show MemoryVault;

void main() {
  sqfliteFfiInit();

  test('unpair clears keychain and every recovery table', () async {
    final dir = await Directory.systemTemp.createTemp('s04-unpair-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await RecoveryStore.open(
      factory: databaseFactoryFfi,
      supportDirectory: () async => dir,
    );
    addTearDown(store.close);
    await store.outbox.insert(
      OutboxCommand(
        commandId: 'cmd_1',
        sessionId: 's1',
        type: 'prompt.send',
        payloadJson: '{"text":"secret"}',
        agentInstanceId: 'agent_1',
        state: OutboxState.persisted,
        createdAt: 1,
        updatedAt: 1,
      ),
    );
    await store.writeCursor(sessionId: 's1', lastContiguousSeq: 3);
    await store.saveDraft('s1', 'draft');
    final vault = MemoryVault();
    final credentials = CredentialStore(vault);
    await credentials.save(
      const DeviceCredential(
        deviceId: 'device_1',
        deviceToken: 'token',
        baseUrl: 'https://mac.example-tailnet.ts.net',
      ),
    );

    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(credentials),
        recoveryStoreProvider.overrideWith((ref) async => store),
      ],
    );
    addTearDown(container.dispose);
    await container.read(pairingControllerProvider.notifier).clearCredential();

    expect(await credentials.read(), isNull);
    expect(await store.outbox.all(), isEmpty);
    expect(await store.readCursor('s1'), isNull);
    expect(await store.readDraft('s1'), isNull);
    expect(await store.cache.readEvents('s1'), isEmpty);
    final tables = await store.db.rawQuery(
      "SELECT name FROM sqlite_master WHERE type = 'table'",
    );
    expect(tables.map((row) => row['name']), contains('outbox_commands'));
  });

  test('unpair in cloud mode clears the desktop-scoped store', () async {
    final dir = await Directory.systemTemp.createTemp('s04-unpair-cloud-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await RecoveryStore.open(
      factory: databaseFactoryFfi,
      supportDirectory: () async => dir,
      fileName: recoveryFileNameFor('cloud-dev_a'),
    );
    addTearDown(store.close);
    await store.saveDraft('s1', 'draft');
    final vault = MemoryVault();
    final credentials = CredentialStore(vault);
    await credentials.save(
      const DeviceCredential(
        deviceId: 'dev_phone1',
        deviceToken: 'token',
        baseUrl: 'https://relay.example.com',
        desktopId: 'dev_a',
        mode: ConnectionMode.cloud,
      ),
    );

    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(credentials),
        recoveryStoreProvider.overrideWith((ref) async => store),
      ],
    );
    addTearDown(container.dispose);
    await container.read(pairingControllerProvider.notifier).clearCredential();

    expect(await credentials.read(), isNull);
    expect(await store.readDraft('s1'), isNull);
  });
}
