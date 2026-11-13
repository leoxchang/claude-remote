import 'package:claude_remote/features/approvals/approval_content_api.dart';
import 'package:claude_remote/features/approvals/approval_content_loader.dart';
import 'package:flutter_test/flutter_test.dart';

import 'approval_test_support.dart';

ApprovalContentLoader loaderFor(FakeTransport transport) {
  return ApprovalContentLoader(
    ApprovalContentApi(
      credentials: credentialStore(),
      transport: transport,
    ),
  );
}

void main() {
  test('loads and verifies unicode content across multiple chunks', () async {
    final json = approvalJson(command: 'echo 中文🙂');
    final chunks = splitUtf8(json, 40);
    final summary = summaryFor(json, chunkCount: chunks.length);
    final transport = FakeTransport(
      chunks: <int, ApprovalTransportResponse>{
        for (var index = 0; index < chunks.length; index += 1)
          index: chunkResponse(
            approvalId: summary.approvalId,
            chunkIndex: index,
            chunkCount: chunks.length,
            byteLength: summary.content.byteLength,
            sha256: summary.content.sha256,
            text: chunks[index],
          ),
      },
    );

    final content = await loaderFor(transport).load(summary);

    expect(chunks.length, greaterThan(1));
    expect(content.sha256, summary.content.sha256);
    expect(content.toolName, 'Bash');
    expect(content.input['command'], 'echo 中文🙂');
    expect(transport.requested, hasLength(chunks.length));
  });

  test('rejects chunk count and byte length mismatches', () async {
    final json = approvalJson();
    final summary = summaryFor(json, chunkCount: 1);

    final wrongCount = FakeTransport(
      chunks: <int, ApprovalTransportResponse>{
        0: chunkResponse(
          approvalId: summary.approvalId,
          chunkIndex: 0,
          chunkCount: 2,
          byteLength: summary.content.byteLength,
          sha256: summary.content.sha256,
          text: json,
        ),
      },
    );
    await expectLater(
      loaderFor(wrongCount).load(summary),
      throwsA(
        isA<ContentIntegrityException>().having(
          (error) => error.code,
          'code',
          'CHUNK_COUNT',
        ),
      ),
    );

    final wrongBytes = FakeTransport(
      chunks: <int, ApprovalTransportResponse>{
        0: chunkResponse(
          approvalId: summary.approvalId,
          chunkIndex: 0,
          chunkCount: 1,
          byteLength: summary.content.byteLength + 1,
          sha256: summary.content.sha256,
          text: json,
        ),
      },
    );
    await expectLater(
      loaderFor(wrongBytes).load(summary),
      throwsA(
        isA<ContentIntegrityException>().having(
          (error) => error.code,
          'code',
          'BYTE_LENGTH',
        ),
      ),
    );
  });

  test('rejects a hash mismatch even when descriptors agree', () async {
    final json = approvalJson();
    final summary = summaryFor(json);
    final transport = FakeTransport(
      chunks: <int, ApprovalTransportResponse>{
        0: chunkResponse(
          approvalId: summary.approvalId,
          chunkIndex: 0,
          chunkCount: 1,
          byteLength: summary.content.byteLength,
          sha256: summary.content.sha256,
          text: '$json ',
        ),
      },
    );

    await expectLater(
      loaderFor(transport).load(summary),
      throwsA(
        isA<ContentIntegrityException>().having(
          (error) => error.code,
          'code',
          'HASH',
        ),
      ),
    );
  });

  test('rejects a chunk served out of order or for another approval', () async {
    final json = approvalJson();
    final summary = summaryFor(json);

    final wrongIndex = FakeTransport(
      chunks: <int, ApprovalTransportResponse>{
        0: chunkResponse(
          approvalId: summary.approvalId,
          chunkIndex: 1,
          chunkCount: 1,
          byteLength: summary.content.byteLength,
          sha256: summary.content.sha256,
          text: json,
        ),
      },
    );
    await expectLater(
      loaderFor(wrongIndex).load(summary),
      throwsA(isA<ContentIntegrityException>()),
    );

    final wrongApproval = FakeTransport(
      chunks: <int, ApprovalTransportResponse>{
        0: chunkResponse(
          approvalId: 'approval_other',
          chunkIndex: 0,
          chunkCount: 1,
          byteLength: summary.content.byteLength,
          sha256: summary.content.sha256,
          text: json,
        ),
      },
    );
    await expectLater(
      loaderFor(wrongApproval).load(summary),
      throwsA(
        isA<ContentIntegrityException>().having(
          (error) => error.code,
          'code',
          'WRONG_APPROVAL',
        ),
      ),
    );
  });

  test('rejects invalid JSON and surfaces terminal HTTP errors', () async {
    final invalid = '{"toolName":';
    final invalidSummary = summaryFor(invalid);
    final invalidTransport = FakeTransport(
      chunks: <int, ApprovalTransportResponse>{
        0: chunkResponse(
          approvalId: invalidSummary.approvalId,
          chunkIndex: 0,
          chunkCount: 1,
          byteLength: invalidSummary.content.byteLength,
          sha256: invalidSummary.content.sha256,
          text: invalid,
        ),
      },
    );
    await expectLater(
      loaderFor(invalidTransport).load(invalidSummary),
      throwsA(
        isA<ContentIntegrityException>().having(
          (error) => error.code,
          'code',
          'INVALID_JSON',
        ),
      ),
    );

    final json = approvalJson();
    final summary = summaryFor(json);
    final expired = FakeTransport(
      onRequest: (index) => const ApprovalTransportResponse(
        statusCode: 410,
        body: '{"error":{"code":"APPROVAL_EXPIRED","message":"expired"}}',
      ),
    );
    await expectLater(
      loaderFor(expired).load(summary),
      throwsA(
        isA<ApprovalContentException>().having(
          (error) => error.code,
          'code',
          'APPROVAL_EXPIRED',
        ),
      ),
    );
  });
}