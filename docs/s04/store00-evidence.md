# STORE-00 证据

**日期：** 2026-11-13（iPhone 补测 2026-11-17）
**STORE-00 Mac:** PASS
**dataProtection:** true
**IPHONE:** PASS（2026-11-17，物理 iPhone 17e / iOS 27.2.1）

**结论：** Mac 部分 **PASS（4/4）**；物理 iPhone 部分 **PASS**（`integration_test/s04_store_gate_test.dart` 真机全绿）。按用户批准的口径，Mac 存储能力作为后续 Task 2–18 的硬门禁，iPhone Data Protection 已于 2026-11-17 补测；S04 整体验收仍取决于 E2E-01–15。

## 1. 环境

| 项 | 值 |
|---|---|
| Node.js | **v24.15.0**（fnm；系统默认 v22.23.2 不用于存储证据） |
| better-sqlite3 | 13.0.3（真实原生模块） |
| SQLite | 3.53.4 |
| 平台 | macOS Darwin 27.2.0 |
| Flutter | 3.47.9 / Dart 3.13.7 |
| sqflite | 2.4.5（`sqflite_common_ffi` 2.4.5 用于测试） |

## 2. Mac 门禁

命令：`S04_LIVE=1 npm run test:s04:store00`（在 Node 24.15.0 下运行）
结果：**4/4 PASS**，5.4s。

覆盖：

1. 真实 better-sqlite3 可加载；`journal_mode=wal`、`foreign_keys=1`、`synchronous=2(FULL)`、`busy_timeout=5000`、`wal_autocheckpoint=1000`、`integrity_check=ok`。
2. 子进程在 `BEGIN IMMEDIATE` 中插入后直接退出（exit 7）：未提交行不存在，已提交行在重开后存在 → 原子回滚。
3. `BEGIN IMMEDIATE` 在第二个连接上返回 `SQLITE_BUSY`（无第二 writer）。
4. 外键违规插入被拒绝。
5. WAL 存在未 checkpoint 内容时用 `db.backup()` 生成备份：备份 `integrity_check=ok` 且包含新行；未用文件复制。
6. 临时目录 0700，DB 0600。

**重要发现：** SQLite 创建的 `-wal`/`-shm` 不会继承 DB 的 0600（实测为 0644）。Task 2 的 `database.ts` 必须在每次打开与写入后对 DB/WAL/SHM 显式 `chmod 0600`，门禁已按此口径验证。

## 3. iPhone 门禁

- 已实现 `apps/mobile/ios/Runner/S04StoreProtection.swift` 与 `integration_test/s04_store_gate_test.dart`：Application Support 内 sqflite WAL 数据库、v1→v2 迁移、重开、DB/WAL/SHM `NSFileProtectionComplete` 设置与回读。
- `flutter build ios --simulator --debug` **PASS**（Swift 与 Xcode 工程引用可编译）。
- 真机执行 `flutter test integration_test/s04_store_gate_test.dart -d 00008150-0001754C0C13401C`：**PASS**（2026-11-17 12:5x，iPhone 17e / iOS 27.2.1，签名团队 2D3M44ZGFK）。用例 `recovery DB migrates, reopens and is Data Protected` 全绿：v1 写入 → v2 迁移保留数据、重开后数据仍可读、WAL 文件存在、`protectDatabase` 对 DB/WAL/SHM 回读 `protected=true`。Xcode build 14.5s，安装启动 21.9s，用例 2s。
- 锁屏后访问失败、解锁重开：**NOT_RUN**，仍需真机手工执行；不得以降低保护级别绕过。

## 4. 未修改项

- 未修改全局 `~/.claude/settings.json`；未复制真实项目、凭证或环境变量；证据只使用合成 ID 与临时目录。
- 依赖通过 pub 镜像（`PUB_HOSTED_URL=https://pub.flutter-io.cn`）解析，因为本机到 `pub.dev` 的 TLS 连接不可用；锁定版本与计划一致。