import 'dart:convert';

import 'package:claude_remote/features/pairing/qr_payload.dart';
import 'package:flutter_test/flutter_test.dart';

String qrJson({
  Object? v = 1,
  Object? baseUrl = 'https://mac.tailnet-abc.ts.net',
  Object? pairingId = 'pair_01',
  Object? code = 'code_0123456789',
  Object? expiresAt,
  Map<String, Object?> extra = const {},
}) {
  return jsonEncode({
    'v': v,
    'baseUrl': baseUrl,
    'pairingId': pairingId,
    'code': code,
    'expiresAt':
        expiresAt ?? DateTime.now().millisecondsSinceEpoch + 60 * 1000,
    ...extra,
  });
}

void main() {
  test('parses a valid one-time pairing payload', () {
    final payload = PairingQrPayload.parse(qrJson());

    expect(payload.v, 1);
    expect(payload.baseUrl, 'https://mac.tailnet-abc.ts.net');
    expect(payload.pairingId, 'pair_01');
    expect(payload.code, 'code_0123456789');
  });

  test('parses a LAN http payload on a private address', () {
    final payload = PairingQrPayload.parse(
      qrJson(baseUrl: 'http://192.168.5.10:8787'),
    );

    expect(payload.baseUrl, 'http://192.168.5.10:8787');
  });

  test('accepts an https host outside the tailnet', () {
    final payload = PairingQrPayload.parse(
      qrJson(baseUrl: 'https://remote.example.com'),
    );

    expect(payload.baseUrl, 'https://remote.example.com');
  });

  for (final invalid in <String, String>{
    'plain http': qrJson(baseUrl: 'http://mac.tailnet-abc.ts.net'),
    'public http host': qrJson(baseUrl: 'http://example.com'),
    'public http ip': qrJson(baseUrl: 'http://8.8.8.8:8787'),
    'http with credentials': qrJson(
      baseUrl: 'http://user:pass@192.168.5.10:8787',
    ),
    'base url with path': qrJson(baseUrl: 'https://example.com/api'),
    'unsupported version': qrJson(v: 2),
    'missing code': qrJson(code: null),
    'missing pairing id': qrJson(pairingId: null),
    'malformed json': '{"v": 1,',
  }.entries) {
    test('rejects ${invalid.key}', () {
      expect(
        () => PairingQrPayload.parse(invalid.value),
        throwsA(isA<PairingPayloadException>()),
      );
    });
  }

  test('rejects an expired payload', () {
    expect(
      () => PairingQrPayload.parse(
        qrJson(expiresAt: DateTime.now().millisecondsSinceEpoch - 1),
      ),
      throwsA(
        isA<PairingPayloadException>().having(
          (error) => error.code,
          'code',
          'QR_EXPIRED',
        ),
      ),
    );
  });

  test('rejects payloads that carry a device token', () {
    expect(
      () => PairingQrPayload.parse(
        qrJson(extra: {'deviceToken': 'DO_NOT_LEAK_99'}),
      ),
      throwsA(
        isA<PairingPayloadException>().having(
          (error) => error.code,
          'code',
          'INVALID_QR',
        ),
      ),
    );
  });

  test('error text never echoes the raw payload', () {
    try {
      PairingQrPayload.parse(
        qrJson(code: 'DO_NOT_LEAK_99', baseUrl: 'http://insecure'),
      );
      fail('should have thrown');
    } on PairingPayloadException catch (error) {
      expect(error.toString(), isNot(contains('DO_NOT_LEAK_99')));
      expect(error.code, isNotEmpty);
    }
  });
}