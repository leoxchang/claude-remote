import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import 'device_credential.dart';

/// 最小键值接口；测试用内存实现替换真实 Keychain。
abstract interface class KeyValueVault {
  Future<String?> read(String key);

  Future<void> write(String key, String value);

  Future<void> delete(String key);
}

/// iOS Keychain 实现；不写入任何普通存储。
final class KeychainVault implements KeyValueVault {
  KeychainVault({FlutterSecureStorage? storage})
    : _storage = storage ?? const FlutterSecureStorage();

  final FlutterSecureStorage _storage;

  @override
  Future<String?> read(String key) => _storage.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _storage.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _storage.delete(key: key);
}

/// 设备凭证的读写入口；凭证整体以 JSON 存入 Keychain 单键。
final class CredentialStore {
  const CredentialStore(this._vault);

  /// Keychain 中的凭证键名。
  static const String credentialKey = 'claude_remote.device_credential';

  final KeyValueVault _vault;

  Future<DeviceCredential?> read() async {
    final raw = await _vault.read(credentialKey);
    if (raw == null) return null;
    final Object? decoded;
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      return null;
    }
    return DeviceCredential.fromJson(decoded);
  }

  Future<void> save(DeviceCredential credential) {
    return _vault.write(credentialKey, jsonEncode(credential.toJson()));
  }

  Future<void> clear() => _vault.delete(credentialKey);
}