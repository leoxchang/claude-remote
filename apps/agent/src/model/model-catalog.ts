/** SDK 返回的单个模型行；`value` 是协议层 /model 命令使用的 id。 */
export interface ModelOption {
  value: string;
  displayName: string;
  description: string;
  /** 该别名解析到的规范 wire 模型 id。 */
  resolvedModel?: string;
}

/** 一次目录查询的句柄；调用方在读完模型列表后必须 close。 */
export interface ModelQueryHandle {
  supportedModels(): Promise<ModelOption[]>;
  close(): void;
}

/** 为给定 cwd 创建目录查询句柄；由 SDK 边界实现。 */
export type ModelQueryFactory = (cwd: string) => ModelQueryHandle;

/** 模型目录服务；Agent 用它了解当前 Mac/workspace 实际可用的模型。 */
export interface ModelCatalogService {
  list(cwd: string): Promise<ModelOption[]>;
}
