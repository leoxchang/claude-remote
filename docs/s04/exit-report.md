# S04 退出报告

**日期：** 2026-11-13
**结论：** **BLOCKED** — Mac 侧实现与自动化测试完成，STORE-00 Mac PASS；物理 iPhone/Data Protection 与 E2E-01–15 未执行，S04 不得验收，不进入 S05。

## 1. 交付内容

| 范围 | 结果 |
|---|---|
| SQLite 单 writer、PRAGMA、0600、backup | 完成；STORE-00 Mac 4/4 PASS |
| V3→V4 两阶段迁移与仓库 | 完成：哈希 fail closed、0600 备份、无第二事实源 |
| 命令幂等与首次结果 | 完成：mutating 永久、read-only 7 天墓碑 |
| 持久事件、commit 后发布 | 完成：同事务 seq/事件/投影 |
| PromptAdmission 与 queued-only 首次结果 | 完成；S02 断言/Flutter/README 已迁移 |
| DB Scheduler 与开始崩溃窗口 | 完成：beginStart 先于 driver、degraded 停止新 start |
| 持久审批与存储降级 | 完成：正文不入库、失败一律 deny |
| 启动修复与先修复后服务 | 完成：锁/迁移/integrity/修复后才监听 |
| afterSeq 同步与分页快照 | 完成：缺口/越界/长离线 RESYNC |
| 保留、容量与存储健康 | 完成：连续前缀、不删幂等墓碑、limited 拒绝新执行 |
| Flutter RecoveryStore/outbox/同步/恢复 UI | 完成：Data Protection 待真机验证 |

## 2. 自动化结果

| 检查 | 结果 |
|---|---|
| `S04_LIVE=1 npm run test:s04:store00` | Mac 4/4 PASS；iPhone BLOCKED |
| `npm run test:s04`（Agent） | 通过：88 文件 / 499 测试 |
| `npm run coverage:agent` | 通过：lines 89.32% / branches 80.06% / functions 89.34% / statements 87.53% |
| `flutter test --coverage` | 通过：234 测试；Dart 行覆盖率 80.0%（2715/3395） |
| `S04_LIVE=1 npm run test:s04:live` | 通过：2/2（commit 前/后崩溃注入；真实 SDK resume） |
| `npm run verify:s04` | FAIL：仅 STORE-00 iPhone/Data Protection、E2E-01–15 NOT_RUN |

## 3. 未完成项

| ID | 状态 | 原因 |
|---|---|---|
| STORE-00 iPhone / E2E-01–15 | BLOCKED | 无物理 iPhone、Tailscale HTTPS/Serve 未配置 |
| 真机 Data Protection | NOT_RUN | 需锁屏与原生属性验证 |
| 真实 SDK 崩溃恢复套件 | NOT_RUN | 需真实网关与设备链路 |

## 4. 已知限制

- outcomeUnknown 表示无法证明工具副作用是否完成；不自动重放。
- 强杀可能丢失一个未 flush 的 delta 窗口。
- run prompt 保留 30 天；只读结果 7 天；Mac DB 依赖 FileVault/0600，iPhone 依赖 Data Protection，不宣称 SQLCipher。
- 不做 transcript 对账、多设备、Relay、APNs。

## 5. 下一步

1. 配置 Tailscale HTTPS Certificates/Serve 并接入 iPhone；
2. 完成 STORE-00 iPhone 与 Data Protection；
3. 执行 E2E-01–15 并回填台账；
4. `npm run verify:s04` PASS 后才进入 S05。
