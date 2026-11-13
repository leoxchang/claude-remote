// ASR-00 真机录音探针：只有物理 iPhone 上的 integration_test 会执行。
//
// 验证 `record 7.1.2` 的 startStream 产出 16 kHz mono PCM16、速率约
// 32,000 B/s（±15%）、chunk 为偶数字节，且不写录音文件。
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:path_provider/path_provider.dart';
import 'package:record/record.dart';

/// 20 秒内允许的总字节偏差。
const double rateTolerance = 0.15;

/// 目标采样率下每秒字节数：16000 samples × 2 bytes。
const int expectedBytesPerSecond = 32000;

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('captures 2 seconds of PCM16 without a recording file', (
    tester,
  ) async {
    final recorder = AudioRecorder();
    final granted = await recorder.hasPermission();
    expect(granted, isTrue, reason: '请在系统弹窗中允许麦克风权限');

    final tempDirectory = await getTemporaryDirectory();
    final filesBefore = tempDirectory.listSync(recursive: true).length;

    final chunks = <Uint8List>[];
    final stream = await recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: 16000,
        numChannels: 1,
      ),
    );
    final subscription = stream.listen(chunks.add);
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(seconds: 2)),
    );
    await recorder.stop();
    await subscription.cancel();
    await recorder.dispose();

    expect(chunks, isNotEmpty);
    for (final chunk in chunks) {
      expect(chunk.length.isEven, isTrue, reason: 'PCM16 不能拆分样本');
    }
    final totalBytes = chunks.fold<int>(0, (sum, chunk) => sum + chunk.length);
    final low = (expectedBytesPerSecond * 2 * (1 - rateTolerance)).round();
    final high = (expectedBytesPerSecond * 2 * (1 + rateTolerance)).round();
    expect(totalBytes, inInclusiveRange(low, high));

    final filesAfter = tempDirectory.listSync(recursive: true).length;
    expect(
      filesAfter,
      filesBefore,
      reason: 'startStream 不得写入录音文件',
    );
  });
}