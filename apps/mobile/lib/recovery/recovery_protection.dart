import 'dart:io' show Platform;

import 'package:flutter/services.dart';

/// Data Protection 设置失败；调用方必须 fail closed。
final class RecoveryProtectionException implements Exception {
  const RecoveryProtectionException();

  @override
  String toString() => 'RecoveryProtectionException';
}

/// 通过原生 Swift 为 RecoveryStore DB/WAL/SHM 设置并验证
/// NSFileProtectionComplete；非 iOS（测试/桌面）跳过。
///
/// 模拟器由原生层在编译期短路，避免在开发环境误用未加密的本地库。
abstract final class RecoveryProtection {
  static const MethodChannel channel = MethodChannel(
    'claude_remote/s04_store_protection',
  );

  static Future<void> protect(String databasePath) async {
    if (!Platform.isIOS) return;
    final report = await channel.invokeMapMethod<String, Object?>(
      'protectDatabase',
      <String, Object?>{'databasePath': databasePath},
    );
    if (report?['protected'] != true) {
      throw const RecoveryProtectionException();
    }
  }
}
