import 'dart:convert';

import 'package:claude_remote/domain/snapshot_assembler.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:claude_remote/protocol/s04_messages.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';

String canonical(Object? value) {
  if (value == null || value is num || value is bool || value is String) {
    return jsonEncode(value);
  }
  if (value is List) return '[${value.map(canonical).join(',')}]';
  final map = value as Map;
  final keys = map.keys.map((key) => '$key').toList()..sort();
  return '{${keys.map((key) => '${jsonEncode(key)}:${canonical(map[key])}').join(',')}}';
}

SnapshotPageMessage page({
  required List<Map<String, Object?>> payloads,
  required int index,
  String? sha,
  int? byteLength,
}) {
  final canonicalBytes = utf8.encode(canonical(payloads));
  return SnapshotPageMessage(
    snapshotId: 'snap_1',
    sessionId: 's1',
    lastSeq: 5,
    pageIndex: index,
    pageCount: payloads.length,
    byteLength: byteLength ?? canonicalBytes.length,
    sha256: sha ?? sha256.convert(canonicalBytes).toString(),
    payload: payloads[index],
  );
}

TimelineEvent event(int seq) {
  return TimelineEvent(
    messageId: 'msg_$seq',
    timestamp: 1,
    type: 'message.completed',
    payload: {'text': 'm$seq'},
    eventId: 'event_$seq',
    sessionId: 's1',
    seq: seq,
  );
}

void main() {
  test('assembles pages only when count, hash and byteLength match', () {
    final payloads = <Map<String, Object?>>[
      {
        'lastSeq': 5,
        'session': {'sessionId': 's1', 'title': 'T'},
        'recentEvents': [
          {
            'protocolVersion': 1,
            'messageId': 'msg_1',
            'timestamp': 1,
            'type': 'message.completed',
            'eventId': 'event_1',
            'sessionId': 's1',
            'seq': 1,
            'payload': {'text': 'm1'},
          },
        ],
      },
      {
        'lastSeq': 5,
        'recentEvents': [
          {
            'protocolVersion': 1,
            'messageId': 'msg_2',
            'timestamp': 2,
            'type': 'message.completed',
            'eventId': 'event_2',
            'sessionId': 's1',
            'seq': 2,
            'payload': {'text': 'm2'},
          },
        ],
      },
    ];
    final assembler = SnapshotAssembler();
    expect(assembler.add(page(payloads: payloads, index: 0)), isNull);
    final assembly = assembler.add(page(payloads: payloads, index: 1));
    expect(assembly, isNotNull);
    expect(assembly!.lastSeq, 5);
    expect(assembly.events.map((event) => event.seq), [1, 2]);
    expect(assembly.firstPage['session'], isNotNull);
  });

  test('rejects hash mismatch, manifest mismatch and missing pages', () {
    final payloads = <Map<String, Object?>>[
      {'lastSeq': 1, 'recentEvents': []},
      {'lastSeq': 1, 'recentEvents': []},
    ];
    expect(
      () => SnapshotAssembler().add(
        page(payloads: payloads, index: 0, sha: 'wrong'),
      ),
      returnsNormally,
    );
    final assembler = SnapshotAssembler();
    assembler.add(page(payloads: payloads, index: 0));
    expect(
      () => assembler.add(
        SnapshotPageMessage(
          snapshotId: 'snap_1',
          sessionId: 's1',
          lastSeq: 2,
          pageIndex: 1,
          pageCount: 2,
          byteLength: 1,
          sha256: 'x',
          payload: payloads[1],
        ),
      ),
      throwsA(isA<SnapshotIntegrityException>()),
    );

    final single = SnapshotAssembler();
    single.add(page(payloads: payloads, index: 0));
    expect(
      () => single.add(
        page(payloads: payloads, index: 0, sha: 'different'),
      ),
      throwsA(isA<SnapshotIntegrityException>()),
    );
  });

  test('detects hash mismatch when all pages arrive', () {
    final payloads = <Map<String, Object?>>[
      {'lastSeq': 1, 'recentEvents': []},
    ];
    final valid = page(payloads: payloads, index: 0);
    final broken = SnapshotPageMessage(
      snapshotId: valid.snapshotId,
      sessionId: valid.sessionId,
      lastSeq: valid.lastSeq,
      pageIndex: 0,
      pageCount: 1,
      byteLength: valid.byteLength,
      sha256: '0' * 64,
      payload: valid.payload,
    );
    expect(
      () => SnapshotAssembler().add(broken),
      throwsA(isA<SnapshotIntegrityException>()),
    );
  });
}
