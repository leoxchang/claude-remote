import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../recovery/recovery_store.dart';

/// 懒打开的本地恢复库；解除配对时整库清理。
final recoveryStoreProvider = FutureProvider<RecoveryStore>((ref) async {
  final store = await RecoveryStore.open();
  ref.onDispose(() {});
  return store;
});