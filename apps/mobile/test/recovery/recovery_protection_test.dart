import 'package:claude_remote/recovery/recovery_protection.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('non-iOS hosts skip native protection without throwing', () async {
    await expectLater(
      RecoveryProtection.protect('/tmp/recovery.db'),
      completes,
    );
  });
}
