import 'dart:convert';

import 'package:claude_remote/features/recovery/recovery_prompt_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;

import '../approvals/approval_test_support.dart';

final class FakeTransport implements RecoveryPromptTransport {
  FakeTransport(this.response);

  http.Response response;
  Uri? lastUri;
  Map<String, String>? lastHeaders;

  @override
  Future<http.Response> get(Uri uri, Map<String, String> headers) async {
    lastUri = uri;
    lastHeaders = headers;
    return response;
  }
}

void main() {
  test('reads the prompt with bearer auth and no local token storage', () async {
    final transport = FakeTransport(
      http.Response.bytes(
        utf8.encode(jsonEncode({'runId': 'run_1', 'text': '原 prompt'})),
        200,
        headers: {'content-type': 'application/json; charset=utf-8'},
      ),
    );
    final api = RecoveryPromptApi(
      credentials: pairedCredentialStore(),
      transport: transport,
    );
    expect(await api.read('run_1'), '原 prompt');
    expect(transport.lastUri?.path, '/v1/runs/run_1/prompt');
    expect(
      transport.lastHeaders?['authorization'],
      startsWith('Bearer device_01.'),
    );
  });

  test('maps terminal errors and malformed responses', () async {
    Future<Object> readWith(http.Response response) async {
      final api = RecoveryPromptApi(
        credentials: pairedCredentialStore(),
        transport: FakeTransport(response),
      );
      try {
        await api.read('run_1');
        return 'ok';
      } on Object catch (error) {
        return error;
      }
    }

    final missing = await readWith(
      http.Response('{"error":{"code":"RUN_NOT_FOUND"}}', 404),
    );
    expect((missing as RecoveryPromptException).code, 'RUN_NOT_FOUND');
    final forbidden = await readWith(http.Response('{}', 403));
    expect((forbidden as RecoveryPromptException).code, 'RUN_NOT_FOUND');
    final invalid = await readWith(http.Response('{"text":1}', 200));
    expect((invalid as RecoveryPromptException).code, 'INVALID_RESPONSE');
    final badJson = await readWith(http.Response('not-json', 500));
    expect((badJson as RecoveryPromptException).code, 'RUN_NOT_FOUND');
  });

  test('rejects unpaired credentials without a network call', () async {
    final transport = FakeTransport(http.Response('{}', 200));
    final api = RecoveryPromptApi(
      credentials: credentialStore(),
      transport: transport,
    );
    await expectLater(
      api.read('run_1'),
      throwsA(isA<RecoveryPromptException>()),
    );
    expect(transport.lastUri, isNull);
  });
}
