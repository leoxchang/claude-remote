import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/credential_store.dart';
import '../../data/device_credential.dart';
import '../../data/pairing_api.dart';
import '../../data/recovery_providers.dart';
import 'qr_payload.dart';

/// 配对页状态机；与 spec §13.2 的 `pairingState` 对齐。
enum PairingStatus { unpaired, scanning, pairing, paired, failed }

/// 配对页的不可变状态。
final class PairingState {
  const PairingState({
    required this.status,
    this.message,
    this.credential,
    this.failures = 0,
  });

  final PairingStatus status;
  final String? message;
  final DeviceCredential? credential;
  final int failures;

  /// 不输出 token；便于日志安全。
  @override
  String toString() => 'PairingState(status: $status, failures: $failures)';
}

/// 设备凭证存储；测试通过覆盖此 provider 注入内存实现。
final credentialStoreProvider = Provider<CredentialStore>(
  (ref) => CredentialStore(KeychainVault()),
);

/// 配对 HTTP 客户端；测试通过覆盖此 provider 注入 MockClient。
final pairingApiProvider = Provider<PairingApi>((ref) => PairingApi());

/// 配对流程控制器。
final pairingControllerProvider =
    NotifierProvider<PairingController, PairingState>(PairingController.new);

final class PairingController extends Notifier<PairingState> {
  /// 单个配对二维码允许的失败次数，与 Mac 侧一致。
  static const int maxFailures = 5;

  /// 本机设备名；S01 不支持改名。
  static const String deviceName = 'User iPhone';

  @override
  PairingState build() => const PairingState(status: PairingStatus.unpaired);

  /// 进入扫码状态；失败的计数保留。
  void startScan() {
    state = PairingState(
      status: PairingStatus.scanning,
      failures: state.failures,
    );
  }

  /// 处理一次扫码结果；成功时把凭证写入 Keychain。
  Future<void> submit(String raw) async {
    if (state.status == PairingStatus.pairing ||
        state.status == PairingStatus.paired) {
      return;
    }
    if (state.failures >= maxFailures) {
      state = PairingState(
        status: PairingStatus.failed,
        message: '本次配对已失效，请回到 Mac 重新生成二维码',
        failures: state.failures,
      );
      return;
    }
    final PairingQrPayload payload;
    try {
      payload = PairingQrPayload.parse(raw);
    } on PairingPayloadException catch (error) {
      _fail(_messageFor(error.code));
      return;
    }
    state = PairingState(
      status: PairingStatus.pairing,
      failures: state.failures,
    );
    try {
      final credential = await ref
          .read(pairingApiProvider)
          .pair(payload, deviceName);
      await ref.read(credentialStoreProvider).save(credential);
      state = PairingState(
        status: PairingStatus.paired,
        credential: credential,
        failures: state.failures,
      );
    } on PairingException catch (error) {
      _fail(_messageFor(error.code));
    }
  }

  /// 只删除本机凭证与恢复数据；Mac 上的令牌仍需单独吊销。
  Future<void> clearCredential() async {
    await ref.read(credentialStoreProvider).clear();
    try {
      final store = await ref.read(recoveryStoreProvider.future);
      await store.clearAll();
    } on Object {
      // 尚未打开本地恢复库时无需清理。
    }
    state = const PairingState(status: PairingStatus.unpaired);
  }

  void _fail(String message) {
    state = PairingState(
      status: PairingStatus.failed,
      message: message,
      failures: state.failures + 1,
    );
  }

  String _messageFor(String code) {
    return switch (code) {
      'QR_EXPIRED' || 'PAIRING_EXPIRED' => '二维码或配对码已过期，请回到 Mac 重新生成',
      'UNSUPPORTED_QR_VERSION' => '二维码版本不受支持，请升级 App',
      'VERSION_INCOMPATIBLE' => 'App 与 Mac 协议版本不兼容，请升级后重试',
      'DEVICE_ALREADY_PAIRED' => 'Mac 已配对其他设备，请先在 Mac 上解除绑定',
      'RATE_LIMITED' => '配对尝试过于频繁，请稍候再试',
      'DESKTOP_OFFLINE' => '无法连接 Mac，请确认 Tailscale 已连接',
      _ => '配对失败，请重试',
    };
  }
}