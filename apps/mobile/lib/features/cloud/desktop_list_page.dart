import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../data/cloud_api.dart';
import '../pairing/pairing_page.dart';
import '../workspaces/workspace_page.dart';
import 'cloud_routes.dart';
import 'desktop_list_controller.dart';

/// 云端电脑列表：选择控制目标、刷新与退出账号。
class DesktopListPage extends ConsumerStatefulWidget {
  const DesktopListPage({
    super.key,
    this.workspaceRoute = WorkspacePage.routeName,
  });

  static const String routeName = cloudDesktopListRoute;

  final String workspaceRoute;

  @override
  ConsumerState<DesktopListPage> createState() => _DesktopListPageState();
}

class _DesktopListPageState extends ConsumerState<DesktopListPage> {
  @override
  void initState() {
    super.initState();
    unawaited(ref.read(desktopListControllerProvider.notifier).refresh());
  }

  Future<void> _select(String desktopId) async {
    await ref.read(desktopListControllerProvider.notifier).select(desktopId);
    if (!mounted) return;
    Navigator.of(context).pushReplacementNamed(widget.workspaceRoute);
  }

  Future<void> _logout() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (dialogContext) => AlertDialog(
        title: const Text('退出云端账号'),
        content: const Text(
          '将吊销本机在云端的设备记录并清除本机缓存；电脑上正在执行的 run 不受影响。',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('取消'),
          ),
          FilledButton(
            key: const Key('cloudLogoutConfirm'),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('退出'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;
    await ref.read(desktopListControllerProvider.notifier).logout();
    if (!mounted) return;
    Navigator.of(context).pushReplacementNamed(PairingPage.routeName);
  }

  @override
  Widget build(BuildContext context) {
    final state = ref.watch(desktopListControllerProvider);
    return Scaffold(
      appBar: AppBar(
        title: const Text('电脑'),
        actions: [
          IconButton(
            tooltip: '刷新',
            icon: const Icon(Icons.refresh),
            onPressed: () =>
                ref.read(desktopListControllerProvider.notifier).refresh(),
          ),
          TextButton(
            key: const Key('cloudLogoutButton'),
            onPressed: _logout,
            child: const Text('退出账号'),
          ),
        ],
      ),
      body: _body(state),
    );
  }

  Widget _body(DesktopListState state) {
    final error = state.error;
    if (error != null) {
      return Center(child: Text(DesktopListController.messageFor(error)));
    }
    if (state.loading && state.desktops.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    if (state.desktops.isEmpty) {
      return const Center(
        child: Text('账号下还没有电脑，请在电脑上运行 relay login'),
      );
    }
    return ListView(
      children: [
        for (final desktop in state.desktops)
          _tile(desktop, state.selectedDesktopId),
      ],
    );
  }

  Widget _tile(CloudDesktop desktop, String? selectedDesktopId) {
    final selected = desktop.desktopId == selectedDesktopId;
    final onlineColor = desktop.online
        ? Colors.green
        : Theme.of(context).colorScheme.outline;
    return ListTile(
      key: Key('desktopListTile_${desktop.desktopId}'),
      title: Text(desktop.desktopName),
      subtitle: Text('${desktop.platform} · ${desktop.appVersion}'),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.circle, size: 10, color: onlineColor),
          if (selected) ...[
            const SizedBox(width: 8),
            const Icon(Icons.check),
          ],
        ],
      ),
      onTap: () => _select(desktop.desktopId),
    );
  }
}
