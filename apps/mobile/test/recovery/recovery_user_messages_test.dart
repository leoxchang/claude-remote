import 'dart:io';

import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:claude_remote/recovery/user_message.dart';
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

  test('stores user messages in send order', () async {
    final dir = await Directory.systemTemp.createTemp('s06-user-msg-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_1',
        commandId: 'cmd_1',
        text: 'first',
        createdAt: 100,
      ),
    );
    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_1',
        commandId: 'cmd_2',
        text: 'second',
        createdAt: 200,
      ),
    );

    final messages = await store.readUserMessages('session_1');

    expect(messages.map((message) => message.text), ['first', 'second']);
  });

  test('is idempotent per commandId', () async {
    final dir = await Directory.systemTemp.createTemp('s06-user-msg-idem-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_1',
        commandId: 'cmd_1',
        text: 'first',
        createdAt: 100,
      ),
    );
    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_1',
        commandId: 'cmd_1',
        text: 'retry',
        createdAt: 300,
      ),
    );

    final messages = await store.readUserMessages('session_1');

    expect(messages, hasLength(1));
    expect(messages.single.text, 'first');
  });

  test('keeps only the newest 200 messages per session', () async {
    final dir = await Directory.systemTemp.createTemp('s06-user-msg-cap-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    for (var index = 0; index < 205; index += 1) {
      await store.appendUserMessage(
        UserMessage(
          sessionId: 'session_1',
          commandId: 'cmd_$index',
          text: 'message $index',
          createdAt: index,
        ),
      );
    }

    final messages = await store.readUserMessages('session_1');

    expect(messages, hasLength(RecoveryStore.maxUserMessagesPerSession));
    expect(messages.first.text, 'message 5');
    expect(messages.last.text, 'message 204');
  });

  test('stores attachment paths with the prompt', () async {
    final dir = await Directory.systemTemp.createTemp('s06-user-msg-img-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);

    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_1',
        commandId: 'cmd_1',
        text: '看这张',
        attachmentPaths: ['/tmp/a.jpg', '/tmp/b.png'],
        createdAt: 100,
      ),
    );

    final messages = await store.readUserMessages('session_1');

    expect(messages.single.attachmentPaths, ['/tmp/a.jpg', '/tmp/b.png']);
  });

  test('copies a picked image into the support directory', () async {
    final dir = await Directory.systemTemp.createTemp('s06-user-attach-');
    addTearDown(() => dir.delete(recursive: true));
    final source = File('${dir.path}/picked.jpg')
      ..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0xe0]);
    final store = await openStore(dir);
    addTearDown(store.close);

    final target = await store.copyUserAttachment(
      commandId: 'cmd_prompt_1',
      sourcePath: source.path,
      index: 0,
    );

    expect(target, endsWith('user-attachments/cmd_prompt_1_0.jpg'));
    expect(File(target).readAsBytesSync(), source.readAsBytesSync());
  });

  test('adds the attachmentPaths column when migrating v3 to v4', () async {
    final dir = await Directory.systemTemp.createTemp('s06-user-msg-v4-');
    addTearDown(() => dir.delete(recursive: true));
    final path = '${dir.path}/recovery.db';
    final legacy = await databaseFactoryFfi.openDatabase(
      path,
      options: OpenDatabaseOptions(
        version: 3,
        onCreate: (db, version) async {
          await db.execute('''
            CREATE TABLE user_messages (
              sessionId TEXT NOT NULL,
              commandId TEXT NOT NULL,
              text TEXT NOT NULL,
              createdAt INTEGER NOT NULL,
              PRIMARY KEY (sessionId, commandId)
            )
          ''');
        },
      ),
    );
    await legacy.insert('user_messages', {
      'sessionId': 'session_1',
      'commandId': 'cmd_old',
      'text': '旧问题',
      'createdAt': 1,
    });
    await legacy.close();

    final store = await openStore(dir);
    addTearDown(store.close);

    final messages = await store.readUserMessages('session_1');
    expect(messages.single.text, '旧问题');
    expect(messages.single.attachmentPaths, isEmpty);
  });

  test('clears user messages together with the local store', () async {
    final dir = await Directory.systemTemp.createTemp('s06-user-msg-clear-');
    addTearDown(() => dir.delete(recursive: true));
    final store = await openStore(dir);
    addTearDown(store.close);
    await store.appendUserMessage(
      const UserMessage(
        sessionId: 'session_1',
        commandId: 'cmd_1',
        text: 'first',
        createdAt: 100,
      ),
    );

    await store.clearAll();

    expect(await store.readUserMessages('session_1'), isEmpty);
  });
}