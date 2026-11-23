# S06 已知限制

**日期：** 2026-11-23

## 1. 范围限制

- **单人、单设备：** 一次只绑定一个 iPhone；更换需 `pair --replace`。
- **仅 macOS：** launchd、Tailscale Serve 与存储保护均按 macOS 实现，不支持 Linux/Windows。
- **仅 tailnet：** iPhone 必须接入与 Mac 相同的 tailnet；不提供公网 Relay、APNs/FCM 推送或多设备租约。
- **无自动更新与签名分发：** 升级需手动 `git pull` + 重装服务。

## 2. 运行限制

- **无编译产物：** launchd 用 `node --import tsx` 直接运行 TypeScript 源码，依赖仓库内 `tsx`；删除 `node_modules` 后服务无法启动。
- **密钥轮换需重启：** `DOUBAO_ASR_API_KEY` 只在进程启动时读取；launchd 场景需重新 `service install --env`。
- **ASR 未验收：** 没有真实豆包凭证时 ASR-00 与 S05 语音 E2E 均为 BLOCKED。
- **局域网模式为明文：** `lan enable` 使用 `http://` + `ws://`，同网段设备可嗅探令牌；仅限可信网络，不提供局域网加密。
- **日志只含元数据：** 不记录 prompt、回复、音频或令牌；因此不能靠日志复现具体对话内容。
- **诊断不导出数据：** 诊断包不含数据库内容、prompt、回复或音频；排障以检查项与日志尾部为准。
- **无 SQLCipher：** 依赖 FileVault 与 Data Protection，不是数据库级加密。
- **无自动修复：** `doctor` 只报告 Tailscale/证书/服务状态，不自动修改系统配置。
- **模拟器跳过 Data Protection：** iOS 模拟器不实现 NSFileProtectionComplete，原生层只在模拟器构建里直接报告通过（`#if targetEnvironment(simulator)`）；真机构建仍设置并回读校验，失败即拒绝使用本地库。

## 3. 真机验收限制

- S01–S05 的 65 项真机 E2E 尚未执行，S06 整体验收保持 BLOCKED。
- iPhone 未加入 tailnet 时无法完成扫码配对；Tailscale iOS 在部分区域 App Store 不可用。
- 本地 `tailscale status` 与 Serve 配置在机器重启后可能丢失，需要重新执行第 3 节步骤。

## 4. 未来公网产品化的边界

Relay、PostgreSQL/Redis、推送、多设备控制租约、公网端到端加密、桌面 UI 与多平台支持均不在个人版范围；如需这些能力，应另立阶段重新设计，不在首版偷偷引入。