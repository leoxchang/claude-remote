# Relay 黑盒契约测试套件

本目录是 `protocol/v1/relay-contract.md` 的**可执行形式**。
套件只经网络（HTTP/WS）与 admin CLI 访问被测实现，
**禁止 import `apps/relay/src`**——任何语言的云端实现通过本套件即视为符合契约 v1。

## 运行（本仓库参考实现自动启动）

```bash
npm run test:relay:contract
```

默认行为：每个测试自行 spawn `apps/relay/src/main.ts`（`RELAY_PORT=0`，
临时 `RELAY_DATA_DIR`），从 stdout 的 `{"event":"relay.started","port":…}` 行读取端口。

## 跨语言验收模式（外部实现）

```bash
RELAY_BASE_URL=http://127.0.0.1:8788 RELAY_DATA_DIR=/path/to/data npm run test:relay:contract
```

此时不 spawn 实现，直接访问 `RELAY_BASE_URL`；管理操作（建账号）经
`RELAY_DATA_DIR` 下的 admin CLI 等价入口执行。外部实现必须约定：

1. 启动输出一行 `{"event":"relay.started","host":…,"port":…}`（或由部署方提供端口）。
2. 提供与契约 §9 等价的管理入口：
   `<bin> admin create-user <username> --password <pw>`，
   经 `RELAY_DATA_DIR` 定位运行实例（参考实现为 unix socket）。
3. 「重启后代次不回退」用例在外部模式下自动跳过（由部署方自行验证重启）。

## 编写约束

- 只使用 `helpers/harness.ts` 与 `helpers/clients.ts` 提供的入口。
- 断言契约中的稳定值（错误码、状态码、关闭码、字节上限），不断言日志、时间戳等实现细节。