# S05 回滚说明

**日期：** 2026-11-13

## 1. 关闭语音功能

1. 在 Mac 上移除进程环境中的 `DOUBAO_ASR_API_KEY`（轮换凭证需要重启 Agent）。
2. 重启 Agent；`/ws/asr` 仍存在，但 start 返回 `ASR_NOT_CONFIGURED`。
3. 主控制 WSS、文字 Composer、run/审批与 S04 恢复均不受影响。

如需完全移除路由，删除 `apps/agent/src/app/durable-wire.ts` 中的 `createAsrRuntime` 调用即可；无需改动其他表或协议版本。

## 2. 数据边界

- Mac 不保存任何音频；回滚不需要清理音频文件。
- `voice_drafts` 只存在于 iPhone RecoveryStore；schema v2 是前向迁移。
- 旧版 App（schema v1）不得降级打开 v2 数据库；必须保留 v2 或清空本地存储后重新配对。
- 用户实际发送的文本按 S04 outbox/run prompt 保留，不随语音功能回滚删除。

## 3. 不需要修改的项目

- 不修改全局 `~/.claude/settings.json`。
- 不启用 Tailscale Funnel，不关闭 TLS 校验。
- 不删除主控制历史、审批记录或 S04 outbox。