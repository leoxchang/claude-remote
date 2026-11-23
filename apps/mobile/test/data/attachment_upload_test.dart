import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/data/attachment_upload.dart';
import 'package:claude_remote/data/credential_store.dart';
import 'package:claude_remote/data/device_credential.dart';
import 'package:flutter_test/flutter_test.dart';

final class _MemoryVault implements KeyValueVault {
  final Map<String, String> values = <String, String>{};

  @override
  Future<String?> read(String key) async => values[key];

  @override
  Future<void> write(String key, String value) async {
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async {
    values.remove(key);
  }
}

final class _FakeTransport implements AttachmentTransport {
  _FakeTransport(this.response);

  final AttachmentUploadResponse response;
  final List<({Uri uri, Map<String, String> headers, String body})> calls = [];

  @override
  Future<AttachmentUploadResponse> post(
    Uri uri,
    Map<String, String> headers,
    String body,
  ) async {
    calls.add((uri: uri, headers: headers, body: body));
    return response;
  }
}

void main() {
  late _MemoryVault vault;
  late CredentialStore credentials;
  late File image;

  setUp(() async {
    vault = _MemoryVault();
    credentials = CredentialStore(vault);
    await credentials.save(
      const DeviceCredential(
        deviceId: 'device_1',
        deviceToken: 'token_1',
        baseUrl: 'http://192.168.5.128:8787',
      ),
    );
    final dir = Directory.systemTemp.createTempSync('s06-upload-');
    image = File('${dir.path}/a.jpg')
      ..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0xe0]);
    addTearDown(() => dir.deleteSync(recursive: true));
  });

  test('posts the image to the Mac with device bearer auth', () async {
    final transport = _FakeTransport(
      const AttachmentUploadResponse(
        statusCode: 201,
        body:
            '{"attachmentId":"att_12345678","mediaType":"image/jpeg","size":4}',
      ),
    );
    final api = AttachmentApi(credentials: credentials, transport: transport);

    final uploaded = await api.uploadFile(image.path);

    expect(uploaded.attachmentId, 'att_12345678');
    final call = transport.calls.single;
    expect(call.uri.toString(), 'http://192.168.5.128:8787/v1/attachments');
    expect(call.headers['authorization'], 'Bearer device_1.token_1');
    final body = jsonDecode(call.body) as Map<String, dynamic>;
    expect(body['mediaType'], 'image/jpeg');
    expect(base64Decode(body['dataBase64'] as String), [0xff, 0xd8, 0xff, 0xe0]);
  });

  test('rejects a file that is not a supported image', () async {
    final transport = _FakeTransport(
      const AttachmentUploadResponse(statusCode: 201, body: '{}'),
    );
    final api = AttachmentApi(credentials: credentials, transport: transport);
    image.writeAsBytesSync(ascii.encode('hello'));

    expect(
      () => api.uploadFile(image.path),
      throwsA(
        isA<AttachmentUploadException>().having(
          (error) => error.code,
          'code',
          'UNSUPPORTED_IMAGE',
        ),
      ),
    );
    expect(transport.calls, isEmpty);
  });

  test('maps an unauthorized response to UNAUTHENTICATED', () async {
    final transport = _FakeTransport(
      const AttachmentUploadResponse(
        statusCode: 401,
        body: '{"error":{"code":"UNAUTHENTICATED"}}',
      ),
    );
    final api = AttachmentApi(credentials: credentials, transport: transport);

    expect(
      () => api.uploadFile(image.path),
      throwsA(
        isA<AttachmentUploadException>().having(
          (error) => error.code,
          'code',
          'UNAUTHENTICATED',
        ),
      ),
    );
  });

  test('requires pairing before uploading', () async {
    await credentials.clear();
    final transport = _FakeTransport(
      const AttachmentUploadResponse(statusCode: 201, body: '{}'),
    );
    final api = AttachmentApi(credentials: credentials, transport: transport);

    expect(
      () => api.uploadFile(image.path),
      throwsA(
        isA<AttachmentUploadException>().having(
          (error) => error.code,
          'code',
          'UNPAIRED',
        ),
      ),
    );
  });
}