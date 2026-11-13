import 'dart:convert';

import 'package:crypto/crypto.dart';

import '../protocol/messages.dart';
import '../protocol/s04_messages.dart';

/// 快照页校验失败；调用方不得应用任何状态。
final class SnapshotIntegrityException implements Exception {
  const SnapshotIntegrityException(this.code);

  final String code;

  @override
  String toString() => 'SnapshotIntegrityException($code)';
}

/// 收齐并校验后的完整快照；只在内存存在。
final class SnapshotAssembly {
  const SnapshotAssembly({
    required this.sessionId,
    required this.snapshotId,
    required this.lastSeq,
    required this.pageCount,
    required this.pages,
    required this.events,
  });

  final String sessionId;
  final String snapshotId;
  final int lastSeq;
  final int pageCount;
  final List<Map<String, Object?>> pages;
  final List<TimelineEvent> events;

  Map<String, Object?> get firstPage => pages.first;
}

/// 校验页码、数量、byteLength 与 SHA-256；不持久化临时页。
final class SnapshotAssembler {
  final Map<String, Map<int, SnapshotPageMessage>> _pending = {};
  final Map<String, ({String sessionId, int lastSeq, int pageCount, int byteLength, String sha256})>
  _manifests = {};

  /// 收下一页；全部到齐后返回校验通过的完整快照。
  SnapshotAssembly? add(SnapshotPageMessage page) {
    final manifest = _manifests[page.snapshotId];
    if (manifest == null) {
      _manifests[page.snapshotId] = (
        sessionId: page.sessionId,
        lastSeq: page.lastSeq,
        pageCount: page.pageCount,
        byteLength: page.byteLength,
        sha256: page.sha256,
      );
    } else if (manifest.sessionId != page.sessionId ||
        manifest.lastSeq != page.lastSeq ||
        manifest.pageCount != page.pageCount ||
        manifest.byteLength != page.byteLength ||
        manifest.sha256 != page.sha256) {
      _discard(page.snapshotId);
      throw const SnapshotIntegrityException('SNAPSHOT_MANIFEST_MISMATCH');
    }
    if (page.pageCount <= 0 || page.pageIndex < 0 || page.pageIndex >= page.pageCount) {
      _discard(page.snapshotId);
      throw const SnapshotIntegrityException('SNAPSHOT_PAGE_OUT_OF_RANGE');
    }
    final pages = _pending.putIfAbsent(page.snapshotId, () => {});
    final existing = pages[page.pageIndex];
    if (existing != null) {
      if (jsonEncode(existing.payload) != jsonEncode(page.payload)) {
        _discard(page.snapshotId);
        throw const SnapshotIntegrityException('SNAPSHOT_PAGE_CONFLICT');
      }
      return null;
    }
    pages[page.pageIndex] = page;
    if (pages.length < page.pageCount) return null;

    final ordered = [
      for (var index = 0; index < page.pageCount; index += 1) pages[index]!,
    ];
    final payloads = ordered.map((entry) => entry.payload).toList(growable: false);
    final canonical = utf8.encode(_canonicalJson(payloads));
    final digest = sha256.convert(canonical).toString();
    if (digest != page.sha256 || canonical.length != page.byteLength) {
      _discard(page.snapshotId);
      throw const SnapshotIntegrityException('SNAPSHOT_HASH_MISMATCH');
    }
    _discard(page.snapshotId);
    return SnapshotAssembly(
      sessionId: page.sessionId,
      snapshotId: page.snapshotId,
      lastSeq: page.lastSeq,
      pageCount: page.pageCount,
      pages: List<Map<String, Object?>>.unmodifiable(payloads),
      events: List<TimelineEvent>.unmodifiable(
        ordered.expand((entry) => entry.events),
      ),
    );
  }

  void discard(String snapshotId) => _discard(snapshotId);

  void _discard(String snapshotId) {
    _pending.remove(snapshotId);
    _manifests.remove(snapshotId);
  }

  String _canonicalJson(Object? value) {
    if (value is num && value.isFinite && value == value.truncateToDouble()) {
      // Node JSON.stringify(1.0) 输出 1；Dart 默认输出 1.0，必须对齐。
      return value.toInt().toString();
    }
    if (value == null || value is num || value is bool || value is String) {
      return jsonEncode(value);
    }
    if (value is List) {
      return '[${value.map(_canonicalJson).join(',')}]';
    }
    final map = value as Map;
    final keys = map.keys.map((key) => '$key').toList()..sort();
    return '{${keys.map((key) => '${jsonEncode(key)}:${_canonicalJson(map[key])}').join(',')}}';
  }
}