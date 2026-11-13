import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../recovery/recovery_protection.dart';
import '../recovery/recovery_store.dart';

/// 懒打开的本地恢复库；解除配对时整库清理。
final recoveryStoreProvider = FutureProvider<RecoveryStore>((ref) async {
  final store = await RecoveryStore.open();
  // iOS 上必须先把 DB/WAL/SHM 设为 NSFileProtectionComplete，失败即拒绝使用。
  await RecoveryProtection.protect(store.db.path);
  ref.onDispose(() {});
  return store;
});