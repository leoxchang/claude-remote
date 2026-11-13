import 'dart:io';

import 'package:claude_remote/recovery/recovery_store.dart';
import 'package:claude_remote/voice/voice_draft_repository.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  sqfliteFfiInit();
  final factory = databaseFactoryFfi;

  late Directory dir;
  late RecoveryStore store;
  late VoiceDraftRepository drafts;

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('s05-voice-drafts-');
    store = await RecoveryStore.open(
      factory: factory,
      supportDirectory: () async => dir,
    );
    drafts = store.voiceDrafts;
  });

  tearDown(() async {
    await store.close();
    await dir.delete(recursive: true);
  });

  test('appends the final text after one newline', () async {
    await store.saveDraft('session_1', '原草稿');
    final draft = await drafts.commitFinal(
      voiceDraftId: 'vd_1',
      asrStreamId: 'asr_1',
      originSessionId: 'session_1',
      originalDraft: '原草稿',
      finalText: '识别文本。',
    );
    expect(draft.combinedDraft, '原草稿\n识别文本。');
    expect(draft.status, 'pending');
    expect(await store.readDraft('session_1'), '原草稿\n识别文本。');
    expect((await drafts.find('vd_1'))?.combinedDraft, '原草稿\n识别文本。');
  });

  test('uses only the final text when the original draft is empty', () async {
    final draft = await drafts.commitFinal(
      voiceDraftId: 'vd_2',
      asrStreamId: 'asr_2',
      originSessionId: 'session_2',
      originalDraft: '',
      finalText: '只有识别文本。',
    );
    expect(draft.combinedDraft, '只有识别文本。');
    expect(await store.readDraft('session_2'), '只有识别文本。');
  });

  test('refuses to overwrite a draft edited by another path', () async {
    await store.saveDraft('session_1', '原草稿');
    await store.saveDraft('session_1', '用户改过的草稿');
    await expectLater(
      drafts.commitFinal(
        voiceDraftId: 'vd_3',
        asrStreamId: 'asr_3',
        originSessionId: 'session_1',
        originalDraft: '原草稿',
        finalText: '识别文本。',
      ),
      throwsA(isA<VoiceDraftConflict>()),
    );
    expect(await store.readDraft('session_1'), '用户改过的草稿');
    expect(await drafts.find('vd_3'), isNull);
  });

  test('persists combined draft edits to both tables', () async {
    await drafts.commitFinal(
      voiceDraftId: 'vd_4',
      asrStreamId: 'asr_4',
      originSessionId: 'session_1',
      originalDraft: '',
      finalText: '识别文本。',
    );
    final updated = await drafts.updateCombinedDraft(
      'vd_4',
      '识别文本，继续编辑。',
    );
    expect(updated.combinedDraft, '识别文本，继续编辑。');
    expect(await store.readDraft('session_1'), '识别文本，继续编辑。');
    final row = await store.db.query(
      'voice_drafts',
      where: 'voiceDraftId = ?',
      whereArgs: ['vd_4'],
    );
    expect(row.single['combinedDraft'], '识别文本，继续编辑。');
  });

  test('restores the original draft and removes the row', () async {
    await store.saveDraft('session_1', '原草稿');
    await drafts.commitFinal(
      voiceDraftId: 'vd_5',
      asrStreamId: 'asr_5',
      originSessionId: 'session_1',
      originalDraft: '原草稿',
      finalText: '识别文本。',
    );
    await drafts.restoreOriginal('vd_5');
    expect(await store.readDraft('session_1'), '原草稿');
    expect(await drafts.find('vd_5'), isNull);
  });

  test('deletes a draft inside a caller transaction', () async {
    await drafts.commitFinal(
      voiceDraftId: 'vd_6',
      asrStreamId: 'asr_6',
      originSessionId: 'session_1',
      originalDraft: '',
      finalText: '识别文本。',
    );
    await store.db.transaction((txn) async {
      await drafts.deleteWithin(txn, 'vd_6');
    });
    expect(await drafts.find('vd_6'), isNull);
  });

  test('lists only pending drafts for one origin session', () async {
    await drafts.commitFinal(
      voiceDraftId: 'vd_7',
      asrStreamId: 'asr_7',
      originSessionId: 'session_1',
      originalDraft: '',
      finalText: '一',
    );
    await drafts.commitFinal(
      voiceDraftId: 'vd_8',
      asrStreamId: 'asr_8',
      originSessionId: 'session_2',
      originalDraft: '',
      finalText: '二',
    );
    final pending = await drafts.pendingForSession('session_1');
    expect(pending.map((draft) => draft.voiceDraftId), ['vd_7']);
  });

  test('clearAll removes voice drafts with the rest of the store', () async {
    await drafts.commitFinal(
      voiceDraftId: 'vd_9',
      asrStreamId: 'asr_9',
      originSessionId: 'session_1',
      originalDraft: '',
      finalText: '识别文本。',
    );
    await store.clearAll();
    expect(await drafts.find('vd_9'), isNull);
    expect(await store.db.query('voice_drafts'), isEmpty);
  });

  test('stores a combined draft larger than 16 KiB', () async {
    final longText = '长' * 9000;
    final draft = await drafts.commitFinal(
      voiceDraftId: 'vd_10',
      asrStreamId: 'asr_10',
      originSessionId: 'session_1',
      originalDraft: '',
      finalText: longText,
    );
    expect(draft.combinedDraft.length, 9000);
    expect(await store.readDraft('session_1'), longText);
  });
}