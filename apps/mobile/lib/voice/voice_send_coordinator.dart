import 'package:sqflite/sqflite.dart';

import '../connection/command_client.dart';
import '../connection/persistent_command_coordinator.dart';
import 'voice_draft_repository.dart';

/// 普通 Composer 的语音草稿发送入口：outbox 入队与草稿删除同事务。
final class VoiceSendCoordinator {
  VoiceSendCoordinator({
    required PersistentCommandCoordinator commands,
    required VoiceDraftStore drafts,
  }) : _commands = commands,
       _drafts = drafts;

  final PersistentCommandCoordinator _commands;
  final VoiceDraftStore _drafts;

  /// 只调用既有 PersistentCommandCoordinator，不创建新 commandId。
  Future<T> sendPrompt<T>({
    required CommandRequest<T> request,
    String? voiceDraftId,
  }) async {
    final sessionId = request.sessionId;
    if (sessionId == null) {
      throw const CommandFailure('INVALID_REQUEST');
    }
    final wire = await _commands.send(
      commandId: request.commandId,
      sessionId: sessionId,
      type: request.type,
      payload: request.payload,
      withinTransaction: voiceDraftId == null
          ? null
          : (Transaction txn) => _drafts.deleteWithin(txn, voiceDraftId),
    );
    return request.decode(wire);
  }
}