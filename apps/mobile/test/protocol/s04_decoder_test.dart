import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/protocol/decoder.dart';
import 'package:claude_remote/protocol/messages.dart';
import 'package:claude_remote/protocol/s04_messages.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object?> example(String name) {
  final file = File('../../protocol/v1/examples/s04/$name');
  return (jsonDecode(file.readAsStringSync()) as Map)
      .map((key, value) => MapEntry('$key', value));
}

void main() {
  strictWireTests();
  test('decodes shared S04 examples', () {
    final requeue = ProtocolDecoder.decode(
      jsonEncode(example('run-requeue.json')),
    );
    expect(requeue, isA<CommandMessage>());
    expect((requeue as CommandMessage).type, 'run.requeue');

    final recovery = ProtocolDecoder.decode(
      jsonEncode(example('run-recovery-required.json')),
    );
    expect(recovery, isA<TimelineEvent>());
    expect((recovery as TimelineEvent).type, 'run.recovery-required'.replaceAll('-', '_'));

    final page = SyncPageMessage.fromWire(
      (example('session-sync-page.json')['payload'] as Map)['data'] as dynamic,
    );
    expect(page.events.map((event) => event.seq), [1, 2]);
    expect(page.hasMore, isFalse);
    expect(page.volatile?.activeRunId, 'run_01');

    final snapshotEvent = ProtocolDecoder.decode(
      jsonEncode(example('snapshot-page-0.json')),
    ) as ControlMessage;
    final payload = snapshotEvent.payload;
    final session = payload['session'] as Map;
    final manifest = {
      'snapshotId': payload['snapshotId'],
      'sessionId': session['sessionId'],
      'lastSeq': payload['lastSeq'],
      'pageIndex': payload['pageIndex'],
      'pageCount': payload['pageCount'],
      'byteLength': payload['byteLength'],
      'sha256': payload['sha256'],
      'payload': payload,
    };
    final snapshot = SnapshotPageMessage.fromWire(manifest);
    expect(snapshot.pageIndex, 0);
    expect(snapshot.pageCount, 2);
    expect(snapshot.events.single.seq, 1);
  });

  test('rejects malformed S04 models', () {
    expect(
      () => SnapshotPageMessage.fromWire(const {'snapshotId': 'snap'}),
      throwsA(isA<FormatException>()),
    );
  });
}

void strictWireTests() {
  test('rejects missing sync fields and malformed snapshot pages', () {
    expect(
      () => SyncPageMessage.fromWire(
        {'afterSeq': 0, 'lastSeq': 1, 'hasMore': true, 'limit': 100},
      ),
      throwsA(isA<FormatException>()),
    );
    expect(
      () => SnapshotPageMessage.fromWire(
        {'snapshotId': 'snap', 'sessionId': 's1', 'payload': {}},
      ),
      throwsA(isA<FormatException>()),
    );
    final page = SyncPageMessage.fromWire({
      'events': [],
      'nextAfterSeq': 1,
      'lastSeq': 1,
      'hasMore': false,
      'volatile': {
        'activeRunId': 'run_1',
        'pendingApprovalCount': 2,
        'outcomeUnknown': true,
      },
    });
    expect(page.volatile?.pendingApprovalCount, 2);
    expect(page.volatile?.outcomeUnknown, isTrue);
    expect(page.events, isEmpty);
  });
}
