import 'package:flutter/material.dart';

import '../../../domain/model_option.dart';

/// 会话模型选择底部面板；首项为跟随 Mac 默认（value == null），
/// 其余行来自 models.list 清单，显示 displayName 与 description。
/// 选中即回调并关闭。
class ModelPickerSheet extends StatelessWidget {
  const ModelPickerSheet({
    required this.models,
    required this.selected,
    required this.onSelect,
    super.key,
  });

  final List<ModelOption> models;
  final String? selected;
  final void Function(String?) onSelect;

  void _choose(BuildContext context, String? value) {
    Navigator.of(context).pop();
    onSelect(value);
  }

  List<Widget> _tiles(BuildContext context) {
    final tiles = <Widget>[
      ListTile(
        title: const Text('默认（跟随 Mac）'),
        trailing: selected == null ? const Icon(Icons.check) : null,
        onTap: () => _choose(context, null),
      ),
    ];
    for (final option in models) {
      final description = option.description;
      tiles.add(
        ListTile(
          title: Text(option.displayName),
          subtitle: description == null ? null : Text(description),
          trailing: option.value == selected ? const Icon(Icons.check) : null,
          onTap: () => _choose(context, option.value),
        ),
      );
    }
    return tiles;
  }

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(mainAxisSize: MainAxisSize.min, children: _tiles(context)),
    );
  }
}
