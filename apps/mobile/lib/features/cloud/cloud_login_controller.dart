import 'dart:io';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/cloud_api.dart';
import '../../data/device_credential.dart';
import '../../data/pairing_api.dart';
import '../../data/providers.dart' show credentialProvider;
import '../pairing/pairing_controller.dart' show credentialStoreProvider;

/// 登录页状态机；与配对页的失败计数分开管理。
enum CloudLoginStatus { idle, submitting, success, failed }

/// 登录页的不可变状态；不含明文口令。
final class CloudLoginState {
  const CloudLoginState({
    required this.status,
    this.message,
    this.credential,
  });

  final CloudLoginStatus status;
  final String? message;
  final DeviceCredential? credential;

  /// 不输出 token；便于日志安全。
  @override
  String toString() => 'CloudLoginState(status: $status)';
}

/// 云端 REST 客户端；测试覆盖此 provider 注入 MockClient。
final cloudApiProvider = Provider<CloudApi>((ref) => CloudApi());

/// 登录时上报的平台标识；测试覆盖此 provider。
final cloudPlatformProvider = Provider<String>(
  (ref) => Platform.isAndroid ? 'android' : 'ios',
);

/// 云端登录流程控制器。
final cloudLoginControllerProvider =
    NotifierProvider<CloudLoginController, CloudLoginState>(
      CloudLoginController.new,
    );

final class CloudLoginController extends Notifier<CloudLoginState> {
  /// 上报给云端的设备名；与配对页一致。
  static const String deviceName = 'User iPhone';

  @override
  CloudLoginState build() =>
      const CloudLoginState(status: CloudLoginStatus.idle);

  /// 登录成功返回新凭证并写入 Keychain；失败返回 null。
  Future<DeviceCredential?> submit({
    required String relayUrl,
    required String username,
    required String password,
  }) async {
    final current = state;
    if (current.status == CloudLoginStatus.submitting) {
      return current.credential;
    }
    state = CloudLoginState(
      status: CloudLoginStatus.submitting,
      credential: current.credential,
    );
    final String baseUrl;
    try {
      baseUrl = normalizeRelayBaseUrl(relayUrl);
    } on CloudApiException catch (error) {
      return _fail(_messageFor(error.code));
    }
    try {
      final result = await ref
          .read(cloudApiProvider)
          .login(
            baseUrl: baseUrl,
            username: username,
            password: password,
            deviceName: deviceName,
            platform: ref.read(cloudPlatformProvider),
            appVersion: PairingApi.appVersion,
          );
      final credential = DeviceCredential(
        deviceId: result.deviceId,
        deviceToken: result.deviceToken,
        baseUrl: baseUrl,
        mode: ConnectionMode.cloud,
      );
      await ref.read(credentialStoreProvider).save(credential);
      ref.invalidate(credentialProvider);
      state = CloudLoginState(
        status: CloudLoginStatus.success,
        credential: credential,
      );
      return credential;
    } on CloudApiException catch (error) {
      return _fail(_messageFor(error.code));
    } on Object {
      // Keychain 写入失败或未预期的传输错误：保持状态可重试。
      return _fail('登录失败，请重试');
    }
  }

  DeviceCredential? _fail(String message) {
    state = CloudLoginState(
      status: CloudLoginStatus.failed,
      message: message,
      credential: state.credential,
    );
    return null;
  }

  /// 面向用户的固定文案；不暴露内部细节或账号是否存在。
  static String _messageFor(String code) {
    return switch (code) {
      'INVALID_CREDENTIALS' => '账号或口令不正确',
      'ACCOUNT_DISABLED' => '账号已被禁用，请联系管理员',
      'DEVICE_LIMIT_REACHED' => '账号下设备数量已达上限，请先吊销旧设备',
      'RATE_LIMITED' => '尝试过于频繁，请稍后再试',
      'NETWORK' => '无法连接云端，请检查地址与网络',
      'INVALID_URL' => '云端地址无效，请输入如 https://relay.example.com',
      'VERSION_INCOMPATIBLE' => '云端版本与 App 不兼容',
      _ => '登录失败，请重试',
    };
  }
}
