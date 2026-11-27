/// models.list 返回的单个模型选项；清单只来自 wire，App 不内置。
final class ModelOption {
  const ModelOption({
    required this.value,
    required this.displayName,
    this.description,
    this.resolvedModel,
  });

  /// 缺 value 或 displayName 的行返回 null，由调用方跳过。
  static ModelOption? fromWire(Map<String, Object?> wire) {
    final value = wire['value'];
    final displayName = wire['displayName'];
    if (value is! String || value.isEmpty) return null;
    if (displayName is! String || displayName.isEmpty) return null;
    final description = wire['description'];
    final resolvedModel = wire['resolvedModel'];
    return ModelOption(
      value: value,
      displayName: displayName,
      description: description is String ? description : null,
      resolvedModel: resolvedModel is String ? resolvedModel : null,
    );
  }

  final String value;
  final String displayName;
  final String? description;
  final String? resolvedModel;
}

/// models.list 的 command.result.data。
final class ModelCatalog {
  const ModelCatalog({required this.models});

  factory ModelCatalog.fromWire(Map<String, Object?> data) {
    final rawModels = data['models'];
    return ModelCatalog(
      models: rawModels is List
          ? rawModels
              .whereType<Map<dynamic, dynamic>>()
              .map(
                (entry) => ModelOption.fromWire(entry.cast<String, Object?>()),
              )
              .whereType<ModelOption>()
              .toList(growable: false)
          : const <ModelOption>[],
    );
  }

  final List<ModelOption> models;
}
