import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/cloud_api.dart';
import '../../data/device_credential.dart';
import '../../data/providers.dart'
    show approvalOnlineProvider, credentialProvider;
import '../../data/recovery_providers.dart' show recoveryStoreProvider;
import '../../recovery/recovery_store.dart';
import '../chat/chat_controller.dart';
import '../pairing/pairing_controller.dart' show credentialStoreProvider;
import 'cloud_login_controller.dart' show cloudApiProvider;

/// 电脑列表与当前控制目标。
final class DesktopListState {
  const DesktopListState({
    this.loading = false,
    this.desktops = const <CloudDesktop>[],
    this.error,
    this.selectedDesktopId,
  });

  final bool loading;
  final List<CloudDesktop> desktops;
  final String? error;
  final String? selectedDesktopId;

  DesktopListState copyWith({
    bool? loading,
    List<CloudDesktop>? desktops,
    String? error,
    String? selectedDesktopId,
  }) {
    return DesktopListState(
      loading: loading ?? this.loading,
      desktops: desktops ?? this.desktops,
      error: error ?? this.error,
      selectedDesktopId: selectedDesktopId ?? this.selectedDesktopId,
    );
  }
}

final desktopListControllerProvider =
    NotifierProvider<DesktopListController, DesktopListState>(
      DesktopListController.new,
    );

/// 云端模式的电脑列表：刷新、切换与退出账号。
final class DesktopListController extends Notifier<DesktopListState> {
  @override
  DesktopListState build() => const DesktopListState();

  /// 拉取账号下的电脑；令牌失效与网络失败只暴露稳定错误码。
  Future<void> refresh() async {
    final DeviceCredential? credential;
    try {
      credential = await ref.read(credentialProvider.future);
    } on Object {
      state = const DesktopListState(error: 'REQUEST_FAILED');
      return;
    }
    if (credential == null || credential.mode != ConnectionMode.cloud) {
      state = const DesktopListState(error: 'NOT_CLOUD');
      return;
    }
    state = DesktopListState(
      loading: true,
      desktops: state.desktops,
      selectedDesktopId: credential.desktopId,
    );
    try {
      final desktops = await ref
          .read(cloudApiProvider)
          .listDesktops(
            baseUrl: credential.baseUrl,
            deviceId: credential.deviceId,
            deviceToken: credential.deviceToken,
          );
      state = DesktopListState(
        desktops: desktops,
        selectedDesktopId: credential.desktopId,
      );
    } on CloudApiException catch (error) {
      state = DesktopListState(
        error: error.code,
        selectedDesktopId: credential.desktopId,
      );
    } on Object {
      state = DesktopListState(
        error: 'REQUEST_FAILED',
        selectedDesktopId: credential.desktopId,
      );
    }
  }

  /// 切换控制目标：写回 desktopId 并重建连接与本地存储作用域。
  Future<void> select(String desktopId) async {
    if (desktopId.isEmpty) return;
    final DeviceCredential? credential;
    try {
      credential = await ref.read(credentialProvider.future);
    } on Object {
      return;
    }
    if (credential == null || credential.mode != ConnectionMode.cloud) return;
    final selected = credential.withDesktop(desktopId);
    await ref.read(credentialStoreProvider).save(selected);
    ref.read(chatControllerProvider.notifier).resetForDeviceSwitch();
    ref.invalidate(approvalOnlineProvider);
    ref.invalidate(credentialProvider);
    state = state.copyWith(selectedDesktopId: desktopId);
  }

  /// 退出云端账号：尽力吊销本机云端设备，再清 Keychain 与当前电脑的本地数据。
  Future<void> logout() async {
    final DeviceCredential? credential;
    try {
      credential = await ref.read(credentialProvider.future);
    } on Object {
      return;
    }
    if (credential == null) {
      state = const DesktopListState();
      return;
    }
    RecoveryStore? store;
    try {
      store = await ref.read(recoveryStoreProvider.future);
    } on Object {
      store = null;
    }
    try {
      await ref
          .read(cloudApiProvider)
          .revokeDevice(
            baseUrl: credential.baseUrl,
            deviceId: credential.deviceId,
            deviceToken: credential.deviceToken,
            targetDeviceId: credential.deviceId,
          );
    } on Object {
      // 云端吊销失败不阻断本机退出；用户仍可用管理端清理设备。
    }
    try {
      await store?.clearAll();
    } on Object {
      // 本地库清理失败不阻断退出。
    }
    await ref.read(credentialStoreProvider).clear();
    ref.read(chatControllerProvider.notifier).resetForDeviceSwitch();
    ref.invalidate(approvalOnlineProvider);
    ref.invalidate(credentialProvider);
    state = const DesktopListState();
  }

  /// 面向用户的固定文案；不暴露内部细节。
  static String messageFor(String code) {
    return switch (code) {
      'NOT_CLOUD' => '当前不是云端模式',
      'NETWORK' => '无法连接云端，请检查网络',
      'UNAUTHENTICATED' => '登录已失效，请重新登录',
      _ => '加载电脑列表失败，请重试',
    };
  }
}
