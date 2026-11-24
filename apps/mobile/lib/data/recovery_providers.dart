import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../recovery/recovery_database.dart';
import '../recovery/recovery_protection.dart';
import '../recovery/recovery_store.dart';
import 'providers.dart' show credentialProvider;

/// 懒打开的本地恢复库；按凭证作用域分文件打开。
///
/// 直连沿用 `recovery.db`（历史数据不迁移）；云端按 desktopId 隔离。
final recoveryStoreProvider = FutureProvider<RecoveryStore>((ref) async {
  final credential = await ref.watch(credentialProvider.future);
  final store = await RecoveryStore.open(
    fileName: recoveryFileNameFor(credential?.storageScope),
  );
  // iOS 上必须先把 DB/WAL/SHM 设为 NSFileProtectionComplete，失败即拒绝使用。
  await RecoveryProtection.protect(store.db.path);
  ref.onDispose(() {
    unawaited(_closeQuietly(store));
  });
  return store;
});

Future<void> _closeQuietly(RecoveryStore store) async {
  try {
    await store.close();
  } on Object {
    // 切换作用域时旧库可能已被使用方关闭；关闭失败不影响新库。
  }
}
