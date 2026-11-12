import { PermissionGate } from '../src/adapter/managed-run-driver.js';

/** 测试用权限门面：一律拒绝，等价 S01/S02 行为。 */
export function denyAllPermissionGate(
  message: string = 'Mobile approval is not available',
): PermissionGate {
  return {
    request: (_runId, request) =>
      Promise.resolve({
        behavior: 'deny',
        message,
        interrupt: false,
        toolUseID: request.toolUseID,
      }),
  };
}

/** 测试用权限门面：一律允许原始输入。 */
export function allowAllPermissionGate(): PermissionGate {
  return {
    request: (_runId, request) =>
      Promise.resolve({
        behavior: 'allow',
        updatedInput: {},
        toolUseID: request.toolUseID,
      }),
  };
}