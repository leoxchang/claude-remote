import 'dart:convert';

import 'package:sqflite/sqflite.dart';

/// 单 session 事件缓存上限。
const int defaultCachedEventsPerSession = 200;

/// 缓存 session 数量上限。
const int defaultCachedSessions = 10;

/// 缓存总字节目标（20 MiB）。
const int defaultCacheBytes = 20 * 1024 * 1024;

final class CachedEvent {
  const CachedEvent({
    required this.eventId,
    required this.sessionId,
    required this.seq,
    required this.payloadJson,
    required this.cachedAt,
  });

  final String eventId;
  final String sessionId;
  final int seq;
  final String payloadJson;
  final int cachedAt;
}

final class CachedSession {
  const CachedSession({
    required this.sessionId,
    required this.workspaceId,
    required this.title,
    required this.status,
    required this.lastActivityAt,
    required this.cachedAt,
  });

  final String sessionId;
  final String workspaceId;
  final String title;
  final String status;
  final int lastActivityAt;
  final int cachedAt;
}

/// 有界事件/会话缓存；outbox、游标与草稿不参与淘汰。
final class CacheRepository {
  const CacheRepository(
    this.db, {
    this.maxEventsPerSession = defaultCachedEventsPerSession,
    this.maxSessions = defaultCachedSessions,
    this.maxBytes = defaultCacheBytes,
  });

  final Database db;
  final int maxEventsPerSession;
  final int maxSessions;
  final int maxBytes;

  Future<void> putSession(CachedSession session) async {
    await db.insert('cached_sessions', {
      'sessionId': session.sessionId,
      'workspaceId': session.workspaceId,
      'title': session.title,
      'status': session.status,
      'lastActivityAt': session.lastActivityAt,
      'cachedAt': session.cachedAt,
    }, conflictAlgorithm: ConflictAlgorithm.replace);
    await _pruneSessions();
  }

  Future<void> putEvents(
    String sessionId,
    List<CachedEvent> events,
  ) async {
    for (final event in events) {
      await db.insert('cached_events', {
        'eventId': event.eventId,
        'sessionId': sessionId,
        'seq': event.seq,
        'payloadJson': event.payloadJson,
        'cachedAt': event.cachedAt,
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    }
    await _pruneSessionEvents(sessionId);
    await _pruneBytes();
  }

  Future<CachedSession?> readSession(String sessionId) async {
    final rows = await db.query(
      'cached_sessions',
      where: 'sessionId = ?',
      whereArgs: [sessionId],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final row = rows.first;
    return CachedSession(
      sessionId: row['sessionId'] as String,
      workspaceId: row['workspaceId'] as String,
      title: row['title'] as String,
      status: row['status'] as String,
      lastActivityAt: row['lastActivityAt'] as int,
      cachedAt: row['cachedAt'] as int,
    );
  }

  Future<List<CachedSession>> readSessions() async {
    final rows = await db.query(
      'cached_sessions',
      orderBy: 'lastActivityAt DESC',
    );
    return rows.map((row) {
      return CachedSession(
        sessionId: row['sessionId'] as String,
        workspaceId: row['workspaceId'] as String,
        title: row['title'] as String,
        status: row['status'] as String,
        lastActivityAt: row['lastActivityAt'] as int,
        cachedAt: row['cachedAt'] as int,
      );
    }).toList(growable: false);
  }

  Future<List<CachedEvent>> readEvents(String sessionId) async {
    final rows = await db.query(
      'cached_events',
      where: 'sessionId = ?',
      whereArgs: [sessionId],
      orderBy: 'seq ASC',
    );
    return rows.map((row) {
      return CachedEvent(
        eventId: row['eventId'] as String,
        sessionId: row['sessionId'] as String,
        seq: row['seq'] as int,
        payloadJson: row['payloadJson'] as String,
        cachedAt: row['cachedAt'] as int,
      );
    }).toList(growable: false);
  }

  Future<int> totalBytes() async {
    final rows = await db.query('cached_events', columns: ['payloadJson']);
    return rows.fold<int>(
      0,
      (total, row) => total + utf8.encode(row['payloadJson'] as String).length,
    );
  }

  Future<void> clearSession(String sessionId) async {
    await db.delete(
      'cached_events',
      where: 'sessionId = ?',
      whereArgs: [sessionId],
    );
  }

  Future<void> clearAll() async {
    await db.delete('cached_events');
    await db.delete('cached_sessions');
  }

  Future<void> _pruneSessionEvents(String sessionId) async {
    final rows = await db.query(
      'cached_events',
      columns: ['eventId'],
      where: 'sessionId = ?',
      whereArgs: [sessionId],
      orderBy: 'seq DESC',
    );
    if (rows.length <= maxEventsPerSession) return;
    final obsolete = rows.skip(maxEventsPerSession).toList(growable: false);
    for (final row in obsolete) {
      await db.delete(
        'cached_events',
        where: 'eventId = ?',
        whereArgs: [row['eventId']],
      );
    }
  }

  Future<void> _pruneSessions() async {
    final rows = await db.query(
      'cached_sessions',
      columns: ['sessionId'],
      orderBy: 'lastActivityAt DESC',
    );
    if (rows.length <= maxSessions) return;
    for (final row in rows.skip(maxSessions)) {
      final sessionId = row['sessionId'] as String;
      await db.delete(
        'cached_events',
        where: 'sessionId = ?',
        whereArgs: [sessionId],
      );
      await db.delete(
        'cached_sessions',
        where: 'sessionId = ?',
        whereArgs: [sessionId],
      );
    }
  }

  Future<void> _pruneBytes() async {
    var bytes = await totalBytes();
    if (bytes <= maxBytes) return;
    final rows = await db.query(
      'cached_events',
      columns: ['eventId', 'payloadJson'],
      orderBy: 'cachedAt ASC',
    );
    for (final row in rows) {
      if (bytes <= maxBytes) break;
      await db.delete(
        'cached_events',
        where: 'eventId = ?',
        whereArgs: [row['eventId']],
      );
      bytes -= utf8.encode(row['payloadJson'] as String).length;
    }
  }
}