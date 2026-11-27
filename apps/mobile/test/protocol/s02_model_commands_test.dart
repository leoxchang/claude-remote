import 'package:claude_remote/domain/model_option.dart';
import 'package:claude_remote/protocol/s02_messages.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('modelsList builds the workspace payload', () {
    final request = S02Commands.modelsList(
      commandId: 'cmd',
      traceId: 'trace',
      workspaceId: 'ws_a',
    );
    expect(request.type, 'models.list');
    expect(request.payload, {'workspaceId': 'ws_a'});
  });

  test('sessionSetModel serializes null and a value', () {
    final clear = S02Commands.sessionSetModel(
      commandId: 'c',
      traceId: 't',
      sessionId: 's',
      model: null,
    );
    expect(clear.type, 'session.set-model');
    expect(clear.sessionId, 's');
    expect(clear.payload, {'model': null});

    final set = S02Commands.sessionSetModel(
      commandId: 'c',
      traceId: 't',
      sessionId: 's',
      model: 'opus',
    );
    expect(set.payload, {'model': 'opus'});
  });

  test('ModelCatalog.fromWire reads rows and skips invalid ones', () {
    final catalog = ModelCatalog.fromWire(<String, Object?>{
      'models': [
        <String, Object?>{
          'value': 'opus',
          'displayName': 'Opus',
          'description': 'Most capable',
          'resolvedModel': 'claude-opus-4-5',
        },
        <String, Object?>{'displayName': 'No value'},
        <String, Object?>{'value': 'no-name'},
        'junk',
      ],
    });

    expect(catalog.models, hasLength(1));
    expect(catalog.models.single.value, 'opus');
    expect(catalog.models.single.displayName, 'Opus');
    expect(catalog.models.single.description, 'Most capable');
    expect(catalog.models.single.resolvedModel, 'claude-opus-4-5');
  });

  test('ModelCatalog.fromWire tolerates a missing models list', () {
    expect(ModelCatalog.fromWire(<String, Object?>{}).models, isEmpty);
  });
}
