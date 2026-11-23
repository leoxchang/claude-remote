import { ApprovalContentController } from '../approval/approval-content-controller.js';
import { AttachmentStore } from '../attachment/attachment-store.js';
import { RunPromptController } from '../run/run-prompt-controller.js';
import { RelayHttpDispatch } from './connector.js';
import {
  errorResult,
  handleApprovalContentRead,
  handleAttachmentUpload,
  handleRunPromptRead,
} from '../transport/http-handlers.js';

const JSON_CONTENT_TYPE = 'application/json';
const APPROVALS_PATH = /^\/v1\/approvals\/([A-Za-z0-9_-]+)\/content$/;
const RUN_PROMPT_PATH = /^\/v1\/runs\/([A-Za-z0-9_-]+)\/prompt$/;

/** relay 代答处理器依赖；与直连手机接口共享同一批控制器。 */
export interface RelayHttpDispatchDeps {
  attachments?: AttachmentStore;
  approvalContent?: ApprovalContentController;
  runPrompt?: RunPromptController;
}

/**
 * 构建 relay http.request 的白名单分发：
 * 附件上传、审批内容、run prompt 三个端点与直连语义一致，其余 404。
 */
export function createRelayHttpDispatch(
  deps: RelayHttpDispatchDeps,
): RelayHttpDispatch {
  return (request) => {
    if (request.method === 'POST' && request.path === '/v1/attachments') {
      if (request.contentType !== JSON_CONTENT_TYPE) {
        return errorResult(415, 'INVALID_MESSAGE');
      }
      let payload: unknown;
      try {
        payload = JSON.parse(request.body.toString('utf8'));
      } catch {
        return errorResult(400, 'INVALID_MESSAGE');
      }
      return handleAttachmentUpload(deps, {
        deviceId: request.deviceId,
        payload,
      });
    }
    if (request.method === 'GET') {
      const approvals = APPROVALS_PATH.exec(request.path);
      if (approvals !== null) {
        return handleApprovalContentRead(deps, {
          deviceId: request.deviceId,
          approvalId: approvals[1] ?? '',
          query: { ...(request.query ?? {}) },
        });
      }
      const runs = RUN_PROMPT_PATH.exec(request.path);
      if (runs !== null) {
        return handleRunPromptRead(deps, {
          deviceId: request.deviceId,
          runId: runs[1] ?? '',
        });
      }
    }
    return errorResult(404, 'ROUTE_NOT_FOUND');
  };
}