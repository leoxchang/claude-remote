# 云端中转计划三：手机云端模式 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** App（`apps/mobile`）新增云端模式：填写云端地址并登录、列出名下电脑并切换控制目标、按 `desktopId` 路由请求与隔离本地缓存；直连扫码模式原样保留。

**Architecture:** 复用现有 `DeviceCredential`（`deviceId`/`deviceToken`/`baseUrl`/`desktopId`）作为两种模式的统一凭证，新增 `mode` 区分直连与云端；云端模式下所有 WS/HTTP 端点自动追加 `desktopId` 查询参数，协议层与 ConnectionController 零改动。云端 REST（登录、电脑列表、吊销）由新增的 `CloudApi` 按 `protocol/v1/relay-contract.md` 实现；登录与电脑列表各配一个 Riverpod 控制器与页面。本地恢复库（`recovery.db`）按 desktopId 分文件隔离。

**Tech Stack:** Flutter + Riverpod 3 + `web_socket_channel` + `http`（含 `MockClient` 测试）+ `flutter_secure_storage` + `sqflite`/`sqflite_common_ffi`。

**Spec:** `docs/superpowers/specs/2026-11-23-cloud-relay-design.md` §7.3（App 改动）与 §2/§3；接口以 `protocol/v1/relay-contract.md` 为唯一依据（§3.1 登录、§3.2 电脑列表、§3.4 吊销、§3.6 代理端点、§4 手机 WS）。

## Global Constraints

- 契约 v1 是唯一对接依据：请求/响应字段、错误码、`Bearer <deviceId>.<deviceToken>` 格式一律照 `protocol/v1/relay-contract.md`，不引入契约外字段。
- protocol v1 与 relay 契约均不改动；协议层（`lib/protocol/`）与 `ConnectionController` 的握手/重连逻辑零改动。
- 直连模式行为不变：旧 Keychain 条目没有 `mode` 字段时按 `direct` 解析；直连请求不追加 `desktopId`。
- 令牌与口令只进 Keychain；不得出现在普通存储、日志、错误消息或异常 `toString()`。HTTP 错误只暴露稳定错误码。
- 不新增运行时依赖：只用现有 `http`、`web_socket_channel`、`flutter_secure_storage`、`sqflite`、`flutter_riverpod`。
- 代码风格沿用仓库现状：`final class`、具名导出、2 空格缩进、不可变状态 + `copyWith`、错误只保留稳定 code；UI 文案为中文。
- 测试驱动：每个生产改动先有失败测试；`flutter analyze` 零告警；`cd apps/mobile && flutter test --coverage` 全局行覆盖 ≥ 80%（现状约 83.7%，不得下降）。
- 外部数据（relay 的响应、用户输入的地址）一律在边界校验；relay 返回的 `desktopId` 等字符串视为不可信（禁止直接拼进文件名）。

## Review Focus

以下输入/故障模式不在任何单个任务的测试里穷尽，但计划已为每条挂上测试；实现者必须让这些测试存在并通过。

1. 云端地址输入含裸域名、端口、末尾斜杠、`/api` 路径、userinfo 或非 http(s) 协议 → 地址必须被规范化或明确报 `INVALID_URL`，绝不拼出 `//v1/...` 畸形 URL（Task 2）。
2. 云端登录成功但未选电脑即杀进程重启 → 首屏必须进电脑列表页；任何连接路径都不得在缺少 `desktopId` 时构造请求（Task 5；Task 1 的 `webSocketUri` 抛 `StateError`）。
3. 切换电脑后旧电脑的事件/草稿/缓存与旧 WS 连接必须退出：缓存按 desktopId 隔离（Task 4），`ChatController` 重置且旧 runtime 被 `ref.onDispose` 断开（Task 5）。
4. relay 返回的 `desktopId` 含 `../`、`/`、空格或超长 → 存储文件名必须清洗（`storageScope`），不得路径穿越或崩溃（Task 1）。
5. 令牌被吊销（401）或 relay 返回畸形 JSON → 稳定错误码与可重试提示，不泄露 token/口令（Task 2 的错误映射与畸形响应测试）。

---

### Task 1: 凭证模式（direct/cloud）与端点拼接

**Files:**
- Modify: `apps/mobile/lib/data/device_credential.dart`
- Modify: `apps/mobile/lib/data/io_agent_socket.dart`
- Modify: `apps/mobile/lib/voice/voice_asr_client.dart`
- Modify: `apps/mobile/lib/data/attachment_upload.dart`
- Modify: `apps/mobile/lib/features/approvals/approval_content_api.dart`
- Modify: `apps/mobile/lib/features/recovery/recovery_prompt_api.dart`
- Test: create `apps/mobile/test/data/device_credential_test.dart`
- Test: modify `apps/mobile/test/data/io_agent_socket_test.dart`、`apps/mobile/test/voice/voice_asr_client_test.dart`、`apps/mobile/test/data/attachment_upload_test.dart`、`apps/mobile/test/features/approvals/approval_content_loader_test.dart`、`apps/mobile/test/features/recovery/recovery_prompt_api_test.dart`

**Interfaces:**
- Produces（后续任务依赖）：
  - `enum ConnectionMode { direct, cloud }`
  - `DeviceCredential({deviceId, deviceToken, baseUrl, desktopId, mode = ConnectionMode.direct})`
  - `Uri DeviceCredential.webSocketUri(String path)` — 直连：`wss|ws://base/path`；云端：追加 `?desktopId=<id>`；云端缺 `desktopId` 抛 `StateError`
  - `Uri DeviceCredential.httpUri(String path, [Map<String, String> query = const {}])` — 云端把 `desktopId` 合并进 query（同名以 `desktopId` 为准）
  - `String? DeviceCredential.storageScope` — 直连 `null`；云端 `cloud-<清洗后的 desktopId>`；云端未选电脑 `cloud-unselected`
  - `DeviceCredential DeviceCredential.withDesktop(String desktopId)`
  - `normalizeRelayBaseUrl` 不在此任务（Task 2）

- [ ] **Step 1: 写失败测试 — 凭证序列化与端点**

在 `apps/mobile/test/data/device_credential_test.dart` 中写（包括以下 6 个用例；`pairingCredential` 等常量直接内联在测试里）：

```dart
const directCredential = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_secret',
  baseUrl: 'https://mac.example.ts.net',
  desktopId: 'dev_desk1',
);
const cloudCredential = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_secret',
  baseUrl: 'https://relay.example.com',
  desktopId: 'dev_desk1',
  mode: ConnectionMode.cloud,
);
const cloudNoDesktop = DeviceCredential(
  deviceId: 'dev_phone1',
  deviceToken: 'tok_secret',
  baseUrl: 'https://relay.example.com',
  mode: ConnectionMode.cloud,
);

test('direct mode never adds desktopId and websocket uses wss for https', () {
  expect(
    directCredential.webSocketUri('/ws').toString(),
    'wss://mac.example.ts.net/ws',
  );
  expect(
    directCredential.httpUri('/v1/attachments').toString(),
    'https://mac.example.ts.net/v1/attachments',
  );
});

test('cloud mode appends desktopId to ws and http urls', () {
  expect(
    cloudCredential.webSocketUri('/ws/asr').toString(),
    'wss://relay.example.com/ws/asr?desktopId=dev_desk1',
  );
  expect(
    cloudCredential.httpUri('/v1/attachments')
        .queryParameters['desktopId'],
    'dev_desk1',
  );
});

test('cloud mode merges query parameters and desktopId wins on conflict', () {
  final uri = cloudCredential.httpUri(
    '/v1/approvals/appr_1/content',
    const {'chunkIndex': '2', 'desktopId': 'dev_other'},
  );
  expect(uri.path, '/v1/approvals/appr_1/content');
  expect(uri.queryParameters['chunkIndex'], '2');
  expect(uri.queryParameters['desktopId'], 'dev_desk1');
});

test('cloud mode without selected desktop throws', () {
  expect(
    () => cloudNoDesktop.webSocketUri('/ws'),
    throwsA(isA<StateError>()),
  );
  expect(
    () => cloudNoDesktop.httpUri('/v1/attachments'),
    throwsA(isA<StateError>()),
  );
});

test('storageScope keeps direct on legacy null and sanitizes cloud ids', () {
  expect(directCredential.storageScope, isNull);
  expect(cloudNoDesktop.storageScope, 'cloud-unselected');
  expect(
    const DeviceCredential(
      deviceId: 'd',
      deviceToken: 't',
      baseUrl: 'https://relay.example.com',
      desktopId: '../evil dir/x',
      mode: ConnectionMode.cloud,
    ).storageScope,
    isNot(contains('/')),
  );
  expect(
    const DeviceCredential(
      deviceId: 'd',
      deviceToken: 't',
      baseUrl: 'https://relay.example.com',
      desktopId: '../evil dir/x',
      mode: ConnectionMode.cloud,
    ).storageScope,
    startsWith('cloud-'),
  );
});

test('fromJson defaults missing mode to direct and rejects unknown mode', () {
  expect(
    DeviceCredential.fromJson(const {
      'deviceId': 'd',
      'deviceToken': 't',
      'baseUrl': 'https://mac.example.ts.net',
    })?.mode,
    ConnectionMode.direct,
  );
  expect(
    DeviceCredential.fromJson(const {
      'deviceId': 'd',
      'deviceToken': 't',
      'baseUrl': 'https://relay.example.com',
      'mode': 'cloud',
    })?.mode,
    ConnectionMode.cloud,
  );
  expect(
    DeviceCredential.fromJson(const {
      'deviceId': 'd',
      'deviceToken': 't',
      'baseUrl': 'https://relay.example.com',
      'mode': 'satellite',
    }),
    isNull,
  );
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd apps/mobile && flutter test test/data/device_credential_test.dart`
Expected: FAIL —— 编译错误，`ConnectionMode`/`webSocketUri` 等尚不存在。

- [ ] **Step 3: 实现 `DeviceCredential` 扩展**

`device_credential.dart` 增加：
- `enum ConnectionMode { direct, cloud }`；字段 `final ConnectionMode mode`（默认 `direct`）。
- `fromJson`：`mode` 缺失 → `direct`；值为 `'direct'`/`'cloud'` 之外（含非 String）→ 返回 `null`（凭证作废，迫使重新配对/登录）。
- `toJson` 始终写 `'mode': mode.name`。
- `storageScope`：`direct → null`；`cloud` 且 `desktopId == null → 'cloud-unselected'`；否则 `desktopId` 用 `RegExp(r'[^A-Za-z0-9_-]')` 全部替换为 `_`，截断到 48 字符，前缀 `cloud-`。
- `withDesktop(String desktopId)`：返回副本（`mode` 等字段不变）。
- `webSocketUri(String path)`：`Uri.parse(baseUrl).replace(scheme: base.scheme == 'https' ? 'wss' : 'ws', path: path, queryParameters: _query(const {}))`。
- `httpUri(String path, [Map<String, String> query = const {}])`：`Uri.parse(baseUrl).replace(path: path, queryParameters: _query(query))`。
- 私有 `Map<String, String>? _query(Map<String, String> query)`：`direct` 时 `query.isEmpty ? null : query`；`cloud` 时 `desktopId` 为空 → `throw StateError('desktopId not selected')`，否则 `{...query, 'desktopId': desktopId}`（空 query 只剩 desktopId，绝不为空）。
- 保留 `toString()` 只输出 `deviceId`。

Run: `cd apps/mobile && flutter test test/data/device_credential_test.dart`
Expected: PASS。

- [ ] **Step 4: 写失败测试 — 五处调用点改用凭证拼接**

在既有测试中各加一条云端断言（直连断言保持原样）：
- `test/data/io_agent_socket_test.dart`：`cloudCredential`（`baseUrl: 'https://relay.example.com'`, `desktopId: 'dev_desk1'`, `mode: ConnectionMode.cloud`）→ `agentSocketUri(...).toString() == 'wss://relay.example.com/ws?desktopId=dev_desk1'`。
- `test/voice/voice_asr_client_test.dart`：用云端凭证构造 `IoVoiceAsrClientFactory`（注入 `openChannel` 捕获 uri），`connect()` 后断言 `uri.path == '/ws/asr'` 且 `uri.queryParameters['desktopId'] == 'dev_desk1'`。
- `test/data/attachment_upload_test.dart`：凭证改为云端（`desktopId: 'dev_desk1'`）时，`call.uri.queryParameters['desktopId'] == 'dev_desk1'`。
- `test/features/approvals/approval_content_loader_test.dart`（或 `approval_test_support.dart` 的 `requested` 捕获）：云端凭证请求时 `uri.queryParameters` 同时含 `chunkIndex` 与 `desktopId`。
- `test/features/recovery/recovery_prompt_api_test.dart`：云端凭证时 `lastUri` 的 `desktopId` 为 `'dev_desk1'`。

Run: `cd apps/mobile && flutter test test/data test/voice/voice_asr_client_test.dart test/features/approvals test/features/recovery/recovery_prompt_api_test.dart`
Expected: FAIL —— 云端断言失败（当前端点不带 `desktopId`）。

- [ ] **Step 5: 改五处调用点**

- `io_agent_socket.dart`：`agentSocketUri(credential) => credential.webSocketUri('/ws')`。
- `voice_asr_client.dart`：`IoVoiceAsrClientFactory.connect` 内改为 `credential.webSocketUri('/ws/asr')`。
- `attachment_upload.dart`：`credential.httpUri('/v1/attachments')`。
- `approval_content_api.dart`：`credential.httpUri('/v1/approvals/${summary.approvalId}/content', {'chunkIndex': '$chunkIndex'})`。
- `recovery_prompt_api.dart`：`credential.httpUri('/v1/runs/$runId/prompt')`。

Run: `cd apps/mobile && flutter test test/data test/voice/voice_asr_client_test.dart test/features/approvals test/features/recovery/recovery_prompt_api_test.dart`
Expected: PASS（直连用例的输出字符串保持不变）。

- [ ] **Step 6: 全量回归并提交**

Run: `cd apps/mobile && flutter test`
Expected: 全部通过（现有直连用例无改动）。

```bash
git add apps/mobile/lib/data apps/mobile/lib/voice apps/mobile/lib/features/approvals/approval_content_api.dart apps/mobile/lib/features/recovery/recovery_prompt_api.dart apps/mobile/test/data apps/mobile/test/voice/voice_asr_client_test.dart apps/mobile/test/features/approvals apps/mobile/test/features/recovery/recovery_prompt_api_test.dart
git commit -m "feat: route mobile endpoints by credential mode"
```

---

### Task 2: 云端 REST 客户端 `CloudApi`

**Files:**
- Create: `apps/mobile/lib/data/cloud_api.dart`
- Test: create `apps/mobile/test/data/cloud_api_test.dart`

**Interfaces:**
- Consumes: `protocol/v1/relay-contract.md` §2、§3.1、§3.2、§3.4。
- Produces（Task 3/5/6 依赖）：
  - `String normalizeRelayBaseUrl(String raw)` — 失败抛 `CloudApiException('INVALID_URL')`
  - `final class CloudApiException implements Exception { const CloudApiException(this.code); final String code; }`
  - `final class CloudLoginResult { final String accountId; final String deviceId; final String deviceToken; final String role; final int contractVersion; }`
  - `final class CloudDesktop { final String desktopId; final String desktopName; final String platform; final String appVersion; final bool online; final int? lastSeenAt; }`
  - `CloudApi({http.Client? client, Duration timeout = const Duration(seconds: 15)})`
    - `Future<CloudLoginResult> login({required String baseUrl, required String username, required String password, required String deviceName, required String platform, required String appVersion})`
    - `Future<List<CloudDesktop>> listDesktops({required String baseUrl, required String deviceId, required String deviceToken})`
    - `Future<void> revokeDevice({required String baseUrl, required String deviceId, required String deviceToken, required String targetDeviceId})`

- [ ] **Step 1: 写失败测试 — 登录请求与解析**

`apps/mobile/test/data/cloud_api_test.dart`（用 `package:http/testing.dart` 的 `MockClient`，与 `pairing_controller_test.dart` 同法）：

```dart
import 'dart:convert';

import 'package:claude_remote/data/cloud_api.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  test('login posts the contract body and parses the device session', () async {
    late http.Request seen;
    final client = MockClient((request) async {
      seen = request;
      return http.Response(
        jsonEncode({
          'accountId': 'acc_1',
          'deviceId': 'dev_phone1',
          'deviceToken': 'tok_1',
          'role': 'phone',
          'contractVersion': 1,
        }),
        200,
        headers: {'content-type': 'application/json'},
      );
    });
    final api = CloudApi(client: client);
    final result = await api.login(
      baseUrl: 'https://relay.example.com/',
      username: 'alice',
      password: 'secret',
      deviceName: 'iPhone',
      platform: 'ios',
      appVersion: '1.0.0',
    );
    expect(seen.method, 'POST');
    expect(seen.url.toString(), 'https://relay.example.com/v1/auth/login');
    expect(jsonDecode(seen.body), {
      'username': 'alice',
      'password': 'secret',
      'clientType': 'phone',
      'deviceName': 'iPhone',
      'platform': 'ios',
      'appVersion': '1.0.0',
    });
    expect(result.deviceId, 'dev_phone1');
    expect(result.deviceToken, 'tok_1');
    expect(result.role, 'phone');
    expect(result.contractVersion, 1);
  });

  test('login maps contract errors and rejects wrong contract version', () async {
    Future<String> codeFor(http.Response response) async {
      final api = CloudApi(client: MockClient((_) async => response));
      try {
        await api.login(
          baseUrl: 'https://relay.example.com',
          username: 'alice',
          password: 'bad',
          deviceName: 'iPhone',
          platform: 'ios',
          appVersion: '1.0.0',
        );
        return 'ok';
      } on CloudApiException catch (error) {
        return error.code;
      }
    }

    String errorBody(String code) => jsonEncode({
      'error': {'code': code, 'message': code},
    });

    expect(await codeFor(http.Response(errorBody('INVALID_CREDENTIALS'), 401)),
        'INVALID_CREDENTIALS');
    expect(await codeFor(http.Response(errorBody('ACCOUNT_DISABLED'), 403)),
        'ACCOUNT_DISABLED');
    expect(await codeFor(http.Response(errorBody('DEVICE_LIMIT_REACHED'), 409)),
        'DEVICE_LIMIT_REACHED');
    expect(await codeFor(http.Response(errorBody('RATE_LIMITED'), 429)),
        'RATE_LIMITED');
    expect(await codeFor(http.Response('<html>bad gateway</html>', 502)),
        'REQUEST_FAILED');
    expect(
      await codeFor(http.Response(jsonEncode({'role': 'phone'}), 200)),
      'INVALID_RESPONSE',
    );
    expect(
      await codeFor(http.Response(
        jsonEncode({
          'accountId': 'acc_1',
          'deviceId': 'dev_phone1',
          'deviceToken': 'tok_1',
          'role': 'phone',
          'contractVersion': 2,
        }),
        200,
      )),
      'VERSION_INCOMPATIBLE',
    );
  });

  test('network failures surface as NETWORK without leaking credentials', () async {
    final api = CloudApi(
      client: MockClient((_) async => throw http.ClientException('boom')),
    );
    try {
      await api.login(
        baseUrl: 'https://relay.example.com',
        username: 'alice',
        password: 'secret',
        deviceName: 'iPhone',
        platform: 'ios',
        appVersion: '1.0.0',
      );
      fail('expected CloudApiException');
    } on CloudApiException catch (error) {
      expect(error.code, 'NETWORK');
      expect(error.toString(), isNot(contains('secret')));
    }
  });
}
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/mobile && flutter test test/data/cloud_api_test.dart`
Expected: FAIL —— 编译错误 `cloud_api.dart` 不存在。

- [ ] **Step 3: 实现 `CloudApi.login` 与 `normalizeRelayBaseUrl`**

`cloud_api.dart` 要点：
- `normalizeRelayBaseUrl(String raw)`：`raw.trim()` 为空 → `INVALID_URL`；无 scheme 时补 `https://`；`Uri.tryParse` 失败、scheme 不是 `http`/`https`、`host` 为空、`userInfo` 非空、`path` 不是 `''`/`'/'`、`hasQuery`/`hasFragment` → `INVALID_URL`；返回 `Uri(scheme:…, host:…, port:…).toString()`（即无末尾斜杠、无路径）。
- 请求发送抽成私有 `Future<http.Response> _send(Future<http.Response> Function() send)`：`on TimeoutException`/`on http.ClientException` → `throw const CloudApiException('NETWORK')`，其余异常不动。
- `login`：`base = normalizeRelayBaseUrl(baseUrl)`；`POST $base/v1/auth/login`，`content-type: application/json`，body 严格为契约 §3.1 六字段；非 200 → `CloudApiException(_errorCode(response))`；200 解析：`accountId`/`deviceId`/`deviceToken`/`role` 必须是 String 且非空，`contractVersion` 必须 int；`contractVersion != 1` → `VERSION_INCOMPATIBLE`；`role != 'phone'` → `INVALID_RESPONSE`；解析失败（FormatException/类型不符）→ `INVALID_RESPONSE`。
- `_errorCode(http.Response)`：优先取 body 的 `error.code`（String 非空）；否则 `'REQUEST_FAILED'`。错误 `toString()` 只含 code。

Run: `cd apps/mobile && flutter test test/data/cloud_api_test.dart`
Expected: PASS。

- [ ] **Step 4: 写失败测试 — 电脑列表、吊销、地址规范化**

继续在同一测试文件追加：

```dart
test('listDesktops sends bearer auth and parses nullable fields', () async {
  late http.Request seen;
  final client = MockClient((request) async {
    seen = request;
    return http.Response(
      jsonEncode({
        'desktops': [
          {
            'desktopId': 'dev_desk1',
            'desktopName': 'MacBook Pro',
            'platform': 'macos',
            'appVersion': '1.0.0',
            'online': true,
            'lastSeenAt': 1763890000000,
          },
          {
            'desktopId': 'dev_desk2',
            'desktopName': 'Mac mini',
            'platform': 'macos',
            'appVersion': '1.0.0',
            'online': false,
            'lastSeenAt': null,
          },
          {'desktopName': 'broken entry'},
        ],
      }),
      200,
    );
  });
  final desktops = await CloudApi(client: client).listDesktops(
    baseUrl: 'https://relay.example.com',
    deviceId: 'dev_phone1',
    deviceToken: 'tok_1',
  );
  expect(seen.method, 'GET');
  expect(seen.url.toString(), 'https://relay.example.com/v1/desktops');
  expect(seen.headers['Authorization'], 'Bearer dev_phone1.tok_1');
  expect(desktops.length, 2);
  expect(desktops.first.desktopId, 'dev_desk1');
  expect(desktops.first.online, isTrue);
  expect(desktops.first.lastSeenAt, 1763890000000);
  expect(desktops.last.online, isFalse);
  expect(desktops.last.lastSeenAt, isNull);
});

test('listDesktops rejects malformed envelopes and revoked tokens', () async {
  Future<Object> run(http.Response response) async {
    try {
      return await CloudApi(client: MockClient((_) async => response))
          .listDesktops(
        baseUrl: 'https://relay.example.com',
        deviceId: 'dev_phone1',
        deviceToken: 'tok_1',
      );
    } on CloudApiException catch (error) {
      return error.code;
    }
  }

  expect(await run(http.Response('{"desktops":{}}', 200)), 'INVALID_RESPONSE');
  expect(await run(http.Response('{"desktops":"nope"}', 200)),
      'INVALID_RESPONSE');
  expect(
    await run(http.Response(
      '{"error":{"code":"UNAUTHENTICATED","message":"UNAUTHENTICATED"}}',
      401,
    )),
    'UNAUTHENTICATED',
  );
});

test('revokeDevice deletes the device with bearer auth', () async {
  late http.Request seen;
  final client = MockClient((request) async {
    seen = request;
    return http.Response('', 204);
  });
  await CloudApi(client: client).revokeDevice(
    baseUrl: 'https://relay.example.com',
    deviceId: 'dev_phone1',
    deviceToken: 'tok_1',
    targetDeviceId: 'dev_phone1',
  );
  expect(seen.method, 'DELETE');
  expect(seen.url.toString(), 'https://relay.example.com/v1/devices/dev_phone1');
  expect(seen.headers['Authorization'], 'Bearer dev_phone1.tok_1');
});

test('normalizeRelayBaseUrl accepts hosts and rejects paths and schemes', () {
  expect(normalizeRelayBaseUrl(' relay.example.com '),
      'https://relay.example.com');
  expect(normalizeRelayBaseUrl('https://relay.example.com/'),
      'https://relay.example.com');
  expect(normalizeRelayBaseUrl('http://127.0.0.1:8788'),
      'http://127.0.0.1:8788');
  for (final raw in [
    '',
    'https://relay.example.com/api',
    'ftp://relay.example.com',
    'https://user:pass@relay.example.com',
    'https://relay.example.com?x=1',
  ]) {
    expect(
      () => normalizeRelayBaseUrl(raw),
      throwsA(isA<CloudApiException>()
          .having((e) => e.code, 'code', 'INVALID_URL')),
      reason: raw,
    );
  }
});
```

Run: `cd apps/mobile && flutter test test/data/cloud_api_test.dart`
Expected: FAIL —— `listDesktops`/`revokeDevice`/`normalizeRelayBaseUrl` 未实现（编译错误）。

- [ ] **Step 5: 实现 `listDesktops`、`CloudDesktop`、`revokeDevice`**

- `listDesktops`：`GET $base/v1/desktops` + `Authorization: Bearer <deviceId>.<token>`；非 200 → 契约错误码；200 时 `desktops` 必须是 List，否则 `INVALID_RESPONSE`；每个元素用 `CloudDesktop.fromWire` 解析，字段类型不符（`desktopId` 非非空 String 等）返回 `null` 并跳过；`online` 非 bool → `false`；`lastSeenAt` 非 int → `null`。
- `revokeDevice`：`DELETE $base/v1/devices/<targetDeviceId>`（`Uri.encodeComponent` 处理 id）+ Bearer；204 → 正常返回；其余 → 契约错误码（404 为 `DEVICE_NOT_FOUND`）。
- 所有响应解析失败统一 `INVALID_RESPONSE`。

Run: `cd apps/mobile && flutter test test/data/cloud_api_test.dart`
Expected: PASS。

- [ ] **Step 6: 全量回归并提交**

Run: `cd apps/mobile && flutter test`
Expected: 通过。

```bash
git add apps/mobile/lib/data/cloud_api.dart apps/mobile/test/data/cloud_api_test.dart
git commit -m "feat: add cloud relay rest client"
```

---

### Task 3: 云端登录控制器与登录页

**Files:**
- Create: `apps/mobile/lib/features/cloud/cloud_routes.dart`
- Create: `apps/mobile/lib/features/cloud/cloud_login_controller.dart`
- Create: `apps/mobile/lib/features/cloud/cloud_login_page.dart`
- Modify: `apps/mobile/lib/main.dart`（注册 `/cloud/login` 路由）
- Modify: `apps/mobile/lib/features/pairing/pairing_page.dart`（入口按钮）
- Test: create `apps/mobile/test/features/cloud/cloud_login_test.dart`、`apps/mobile/test/features/cloud/cloud_login_page_test.dart`
- Test: modify `apps/mobile/test/features/pairing/pairing_page_test.dart`（入口按钮）

**Interfaces:**
- Consumes: Task 1 的 `ConnectionMode`、`DeviceCredential`；Task 2 的 `CloudApi`、`normalizeRelayBaseUrl`、`CloudApiException`、`CloudLoginResult`。
- Produces：
  - `const String cloudDesktopListRoute = '/cloud/desktops'`（Task 5 注册到该常量）
  - `Provider<CloudApi> cloudApiProvider`
  - `Provider<String> cloudPlatformProvider`（`ios`/`android`）
  - `enum CloudLoginStatus { idle, submitting, success, failed }`
  - `final class CloudLoginState { CloudLoginStatus status; String? message; DeviceCredential? credential; }`
  - `NotifierProvider<CloudLoginController, CloudLoginState> cloudLoginControllerProvider`
  - `Future<DeviceCredential?> CloudLoginController.submit({required String relayUrl, required String username, required String password})`
  - `CloudLoginPage({String nextRoute = cloudDesktopListRoute})`，静态 `routeName = '/cloud/login'`

- [ ] **Step 1: 写失败测试 — 登录控制器**

`apps/mobile/test/features/cloud/cloud_login_test.dart`：用 `MemoryVault`（来自 `../approvals/approval_test_support.dart`）与 `MockClient` 覆盖 `cloudApiProvider`，覆盖 `credentialStoreProvider` 与 `cloudPlatformProvider`：

```dart
test('successful login stores a cloud credential without a desktop', () async {
  final vault = MemoryVault();
  final container = ProviderContainer(overrides: [
    credentialStoreProvider.overrideWithValue(CredentialStore(vault)),
    cloudPlatformProvider.overrideWithValue('ios'),
    cloudApiProvider.overrideWithValue(CloudApi(client: MockClient((request) async {
      return http.Response(jsonEncode({
        'accountId': 'acc_1',
        'deviceId': 'dev_phone1',
        'deviceToken': 'tok_1',
        'role': 'phone',
        'contractVersion': 1,
      }), 200);
    })),
  ]);
  addTearDown(container.dispose);
  final credential = await container
      .read(cloudLoginControllerProvider.notifier)
      .submit(relayUrl: 'relay.example.com', username: 'alice', password: 'secret');
  expect(credential?.deviceId, 'dev_phone1');
  expect(credential?.mode, ConnectionMode.cloud);
  expect(credential?.desktopId, isNull);
  expect(credential?.baseUrl, 'https://relay.example.com');
  final stored = await CredentialStore(vault).read();
  expect(stored?.mode, ConnectionMode.cloud);
  expect(stored?.deviceToken, 'tok_1');
});

test('invalid credentials and bad urls map to safe messages', () async {
  ... submit 时 MockClient 返回 401 INVALID_CREDENTIALS，断言
  container.read(cloudLoginControllerProvider).message == '账号或口令不正确'，
  status == CloudLoginStatus.failed，且 vault 未写入凭证；
  relayUrl: 'https://relay.example.com/api' 时 message 为 '云端地址无效…'。
});
```

Run: `cd apps/mobile && flutter test test/features/cloud/cloud_login_test.dart`
Expected: FAIL —— 编译错误。

- [ ] **Step 2: 实现控制器**

- `cloud_routes.dart`：只放 `const String cloudDesktopListRoute = '/cloud/desktops';`。
- `cloud_login_controller.dart`：
  - `cloudApiProvider = Provider<CloudApi>((ref) => CloudApi())`
  - `cloudPlatformProvider = Provider<String>((ref) => Platform.isAndroid ? 'android' : 'ios')`
  - `CloudLoginController.submit`：先 `normalizeRelayBaseUrl`（`CloudApiException('INVALID_URL')` 在本地捕获，不发起请求）；`CloudApi.login(baseUrl: normalized, deviceName: _deviceName, platform: ref.read(cloudPlatformProvider), appVersion: PairingApi.appVersion)`；成功构造 `DeviceCredential(deviceId: result.deviceId, deviceToken: result.deviceToken, baseUrl: normalized, desktopId: null, mode: ConnectionMode.cloud)`，`await ref.read(credentialStoreProvider).save(...)`，`ref.invalidate(credentialProvider)`（import 自 `../../data/providers.dart`）；失败按 `CloudApiException.code` 映射固定中文文案（INVALID_CREDENTIALS→'账号或口令不正确'，ACCOUNT_DISABLED→'账号已被禁用，请联系管理员'，DEVICE_LIMIT_REACHED→'账号下设备数量已达上限，请先吊销旧设备'，RATE_LIMITED→'尝试过于频繁，请稍后再试'，NETWORK→'无法连接云端，请检查地址与网络'，INVALID_URL→'云端地址无效，请输入如 https://relay.example.com'，VERSION_INCOMPATIBLE→'云端版本与 App 不兼容'，其余→'登录失败，请重试'）。`_deviceName = 'User iPhone'`（与配对页一致）。
  - 状态机：提交中 `submitting`、成功 `success`（带 credential）、失败 `failed`（带 message）。重复提交时若 `submitting`/`success` 直接返回当前 credential。

Run: `cd apps/mobile && flutter test test/features/cloud/cloud_login_test.dart`
Expected: PASS。

- [ ] **Step 3: 写失败测试 — 登录页**

`cloud_login_page_test.dart`：覆盖 `cloudApiProvider`（成功 MockClient）与 `credentialStoreProvider`；`MaterialApp(initialRoute: CloudLoginPage.routeName, routes: {CloudLoginPage.routeName: (…) => const CloudLoginPage(), '/done': (…) => const Scaffold(body: Text('done'))})`，页面用 `CloudLoginPage(nextRoute: '/done')` 注入。断言：
- 输入 `relay.example.com`/`alice`/`secret`（`find.byKey(const Key('cloudRelayUrlField'))` 等）→ 点击 `Key('cloudLoginButton')` → pump 后出现 `done`。
- 错误口令 → 不跳转，显示 '账号或口令不正确'（`Key('cloudLoginError')`）。
- 地址默认值是 `https://`（`expect(find.text('https://'), findsOneWidget)`）。

Run: `cd apps/mobile && flutter test test/features/cloud/cloud_login_page_test.dart`
Expected: FAIL —— 页面不存在。

- [ ] **Step 4: 实现登录页并接线**

- `cloud_login_page.dart`：三个 `TextField`（地址默认 `https://`、用户名、口令 `obscureText`，带上述 Key），登录按钮在 `submitting` 时禁用并显示进度，失败文案用 `Key('cloudLoginError')`；成功后 `Navigator.of(context).pushReplacementNamed(widget.nextRoute)`。
- `main.dart`：`routes` 增加 `CloudLoginPage.routeName: (_) => const CloudLoginPage(),`。
- `pairing_page.dart`：`body` 底部（`_ScanView` 下方）增加 `TextButton(key: Key('cloudLoginEntry'), onPressed: () => Navigator.of(context).pushNamed(CloudLoginPage.routeName), child: const Text('使用云端账号登录'))`；同步在 `pairing_page_test.dart` 加一条断言入口存在。

Run: `cd apps/mobile && flutter test test/features/cloud test/features/pairing`
Expected: PASS。

- [ ] **Step 5: 全量回归并提交**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: 分析零告警、测试全绿。

```bash
git add apps/mobile/lib/features/cloud apps/mobile/lib/main.dart apps/mobile/lib/features/pairing/pairing_page.dart apps/mobile/test/features/cloud apps/mobile/test/features/pairing
git commit -m "feat: add cloud login flow to mobile app"
```

---

### Task 4: 本地恢复库按 desktopId 隔离

**Files:**
- Modify: `apps/mobile/lib/recovery/recovery_database.dart`
- Modify: `apps/mobile/lib/recovery/recovery_store.dart`
- Modify: `apps/mobile/lib/data/recovery_providers.dart`
- Modify: `apps/mobile/lib/features/pairing/pairing_controller.dart`（清库顺序）
- Test: create `apps/mobile/test/recovery/recovery_scope_test.dart`
- Test: modify `apps/mobile/test/features/recovery/unpair_cleanup_test.dart`

**Interfaces:**
- Consumes: Task 1 的 `DeviceCredential.storageScope`。
- Produces：
  - `const String defaultRecoveryFileName = 'recovery.db'`
  - `String recoveryFileNameFor(String? scope)` —— `null → 'recovery.db'`，否则 `'recovery-<scope>.db'`
  - `RecoveryDatabase.open({..., String fileName = defaultRecoveryFileName})`
  - `RecoveryStore.open({..., String fileName = defaultRecoveryFileName})`
  - `recoveryStoreProvider` 改为 `watch(credentialProvider.future)` 并派生文件名；dispose 时关闭 DB

- [ ] **Step 1: 写失败测试 — 作用域文件与数据隔离**

`test/recovery/recovery_scope_test.dart`（`sqfliteFfiInit()` + 临时目录，模式同 `unpair_cleanup_test.dart`）：

```dart
test('scoped stores use distinct files and never share rows', () async {
  final dir = await Directory.systemTemp.createTemp('relay-scope-');
  addTearDown(() => dir.delete(recursive: true));
  final a = await RecoveryStore.open(
    factory: databaseFactoryFfi,
    supportDirectory: () async => dir,
    fileName: recoveryFileNameFor('cloud-dev_a'),
  );
  final b = await RecoveryStore.open(
    factory: databaseFactoryFfi,
    supportDirectory: () async => dir,
    fileName: recoveryFileNameFor('cloud-dev_b'),
  );
  addTearDown(a.close);
  addTearDown(b.close);
  expect(File('${dir.path}/recovery-cloud-dev_a.db').existsSync(), isTrue);
  expect(File('${dir.path}/recovery-cloud-dev_b.db').existsSync(), isTrue);
  await a.saveDraft('s1', 'draft-a');
  expect(await b.readDraft('s1'), isNull);
  expect(recoveryFileNameFor(null), defaultRecoveryFileName);
});
```

并在 `unpair_cleanup_test.dart` 增加第二条用例：云端凭证（`desktopId: 'dev_a'`, `mode: ConnectionMode.cloud`）+ 覆盖 `recoveryStoreProvider` 为用 `recoveryFileNameFor('cloud-dev_a')` 打开的 store，写入草稿后 `clearCredential()`，断言 Keychain 已清且该 scoped store 的草稿/游标清空。

Run: `cd apps/mobile && flutter test test/recovery/recovery_scope_test.dart test/features/recovery/unpair_cleanup_test.dart`
Expected: FAIL —— `recoveryFileNameFor`/`fileName` 参数不存在。

- [ ] **Step 2: 实现文件名参数与 provider**

- `recovery_database.dart`：`open` 增加 `String fileName = defaultRecoveryFileName`，路径 `p.join(directory.path, fileName)`。
- `recovery_store.dart`：`open` 透传 `fileName`；其余不变。
- `recovery_providers.dart`：
  ```dart
  final recoveryStoreProvider = FutureProvider<RecoveryStore>((ref) async {
    final credential = await ref.watch(credentialProvider.future);
    final store = await RecoveryStore.open(
      fileName: recoveryFileNameFor(credential?.storageScope),
    );
    await RecoveryProtection.protect(store.db.path);
    ref.onDispose(() { unawaited(store.close()); });
    return store;
  });
  ```
  （import `credentialProvider` 自 `providers.dart`；Dart 允许该循环 import。）
- `pairing_controller.clearCredential` 改为**先取库后清凭证**：先 `try { store = await ref.read(recoveryStoreProvider.future); } on Object {}`，再 `await credentialStoreProvider.clear()`，再 `await store?.clearAll()`，最后 `ref.invalidate(credentialProvider)`；保证云端模式下清的是当前 desktop 的库而不是旧 `recovery.db`。

Run: `cd apps/mobile && flutter test test/recovery test/features/recovery`
Expected: PASS。

- [ ] **Step 3: 全量回归并提交**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: 通过（直连用户仍使用 `recovery.db`，历史数据不丢）。

```bash
git add apps/mobile/lib/recovery apps/mobile/lib/data/recovery_providers.dart apps/mobile/lib/features/pairing/pairing_controller.dart apps/mobile/test/recovery/recovery_scope_test.dart apps/mobile/test/features/recovery/unpair_cleanup_test.dart
git commit -m "feat: isolate mobile recovery store per desktop"
```

---

### Task 5: 电脑列表、切换与退出云端

**Files:**
- Create: `apps/mobile/lib/features/cloud/desktop_list_controller.dart`
- Create: `apps/mobile/lib/features/cloud/desktop_list_page.dart`
- Modify: `apps/mobile/lib/main.dart`（注册路由 + 首屏分流）
- Modify: `apps/mobile/lib/features/workspaces/workspace_page.dart`（云端模式入口）
- Modify: `apps/mobile/lib/features/chat/chat_controller.dart`（`resetForDeviceSwitch`）
- Modify: `apps/mobile/lib/data/providers.dart`（`chatSessionRuntimeProvider` 注册 dispose）
- Test: create `apps/mobile/test/features/cloud/desktop_list_test.dart`、`apps/mobile/test/features/cloud/start_routing_test.dart`
- Test: modify `apps/mobile/test/features/chat/chat_controller_test.dart`、`apps/mobile/test/features/workspaces/workspace_page_test.dart`

**Interfaces:**
- Consumes: Task 1 `withDesktop`/`ConnectionMode`；Task 2 `CloudApi`/`CloudDesktop`；Task 3 `cloudApiProvider`/`cloudDesktopListRoute`；Task 4 `recoveryFileNameFor`/scoped store。
- Produces：
  - `final class DesktopListState { bool loading; List<CloudDesktop> desktops; String? error; String? selectedDesktopId; }`
  - `NotifierProvider<DesktopListController, DesktopListState> desktopListControllerProvider`
  - `Future<void> DesktopListController.refresh()`、`Future<void> select(String desktopId)`、`Future<void> logout()`
  - `String DesktopListController.messageFor(String code)`
  - `DesktopListPage({String workspaceRoute = WorkspacePage.routeName})`，静态 `routeName = cloudDesktopListRoute`
  - `void ChatController.resetForDeviceSwitch()`
  - `static String StartPage.destinationFor(DeviceCredential? credential, {String pairedRoute = WorkspacePage.routeName})` → 返回路由名

- [ ] **Step 1: 写失败测试 — 列表与切换**

`test/features/cloud/desktop_list_test.dart`：覆盖 `cloudApiProvider`（MockClient 返回两台电脑）、`credentialStoreProvider`（`MemoryVault` 内先存无 desktop 的云端凭证）、`recoveryStoreProvider`（ffi 临时目录、`recoveryFileNameFor('cloud-dev_a')` 打开的 store）：

```dart
test('refresh loads desktops with the phone token', ... 断言 state.desktops.length == 2、selectedDesktopId == null);
test('refresh maps NETWORK to a retryable error', ... 断言 state.error == 'NETWORK');
test('select persists desktopId without changing identity', () async {
  await container.read(desktopListControllerProvider.notifier).select('dev_a');
  final stored = await CredentialStore(vault).read();
  expect(stored?.desktopId, 'dev_a');
  expect(stored?.deviceId, 'dev_phone1');
  expect(stored?.deviceToken, 'tok_1');
  expect(stored?.mode, ConnectionMode.cloud);
  expect(container.read(desktopListControllerProvider).selectedDesktopId, 'dev_a');
});
test('logout revokes, clears keychain and the scoped store', ... 断言 MockClient 收到 DELETE /v1/devices/dev_phone1、vault 为空、store.readDraft('s1') == null、state.desktops 为空);
```

`test/features/chat/chat_controller_test.dart` 追加：

```dart
test('resetForDeviceSwitch clears the attached session and state', () {
  final controller = ChatController();
  controller.attachSession('sess_1');
  controller.updateDraft('draft');
  expect(controller.sessionId, 'sess_1');
  controller.resetForDeviceSwitch();
  expect(controller.sessionId, isNull);
  expect(controller.state.draft, isEmpty);
});
```
（若现有测试使用 ProviderContainer 读取 notifier，沿用它；核心断言是 sessionId 变为 null。）

`test/features/cloud/start_routing_test.dart`：

```dart
test('cloud credential without a desktop goes to the desktop list', () {
  expect(
    StartPage.destinationFor(const DeviceCredential(
      deviceId: 'd', deviceToken: 't',
      baseUrl: 'https://relay.example.com',
      mode: ConnectionMode.cloud,
    )),
    DesktopListPage.routeName,
  );
});
test('cloud with a desktop and direct both go to workspaces', () { ... });
test('no credential goes to pairing', () { ... });
```

Run: `cd apps/mobile && flutter test test/features/cloud test/features/chat/chat_controller_test.dart`
Expected: FAIL —— 编译错误。

- [ ] **Step 2: 实现控制器与重置方法**

- `chat_controller.dart` `resetForDeviceSwitch()`：`_sessionId = null; _coordinator = null; _persistentCommands = null; _voiceDrafts = null; _composerDrafts = null; _userMessages = null; _uploadAttachment = null; _userAttachments = null; state = const ChatState();`（注释：切换电脑后 runtime 重建会重新装配存储与协调器）。
- `desktop_list_controller.dart`：
  - `refresh()`：读 `credentialProvider.future`；null 或 `mode != cloud` → `error='NOT_CLOUD'`；调 `ref.read(cloudApiProvider).listDesktops(...)`；`CloudApiException` → `error=code`；成功 `DesktopListState(desktops: list, selectedDesktopId: credential.desktopId)`。
  - `select(id)`：读凭证；非云端/空 id → 忽略；`credential.withDesktop(id)` 保存；`ref.read(chatControllerProvider.notifier).resetForDeviceSwitch();` `ref.invalidate(approvalOnlineProvider);` `ref.invalidate(credentialProvider);` 更新 state。
  - `logout()`：**先**读 `recoveryStoreProvider.future`（此时 scope 仍有效），尽力 `revokeDevice(target: 自己的 deviceId)`（失败忽略），`store.clearAll()`，`credentialStore.clear()`，`chat.resetForDeviceSwitch()`，`ref.invalidate(credentialProvider)`，state 置空。
  - `messageFor`：`NOT_CLOUD`→'当前不是云端模式'；`NETWORK`→'无法连接云端，请检查网络'；`UNAUTHENTICATED`→'登录已失效，请重新登录'；其余→'加载电脑列表失败，请重试'。
- `providers.dart`：`chatSessionRuntimeProvider` 在返回前 `final runtime = ChatSessionRuntime(...); ref.onDispose(() { unawaited(runtime.dispose()); }); return runtime;`。

Run: `cd apps/mobile && flutter test test/features/cloud/desktop_list_test.dart test/features/chat/chat_controller_test.dart`
Expected: PASS。

- [ ] **Step 3: 写失败测试 — 页面与接线**

`test/features/cloud/desktop_list_page_test.dart`（或并入 `desktop_list_test.dart`）：
- 页面显示两台电脑名称、离线标记、当前选择标记；点击离线电脑仍可切换（云端会在连接时给出 503/4010）。
- 空列表提示 '账号下还没有电脑，请在电脑上运行 relay login'。

`workspace_page_test.dart` 追加：覆盖 `credentialProvider` 为云端凭证后，`find.byKey(const Key('cloudDesktopButton'))` 存在；直连凭证时不存在（用现有的 `pumpWorkspacePage` 辅助，补充 override）。

Run: `cd apps/mobile && flutter test test/features/cloud test/features/workspaces`
Expected: FAIL —— 页面不存在。

- [ ] **Step 4: 实现页面与首屏分流**

- `desktop_list_page.dart`：`ListView` 列出 `state.desktops`（`ListTile` 标题 `desktopName`，副标题 `platform · appVersion`，尾部在线圆点 + 当前选中对勾）；`onTap` → `await controller.select(id)` → `Navigator.of(context).pushReplacementNamed(widget.workspaceRoute)`；AppBar `refresh` 按钮与 `TextButton('退出账号')`（确认对话框后 `logout()` → `pushReplacementNamed(PairingPage.routeName)`）；`Key('desktopListTile_<id>')` 供测试。
- `main.dart`：`routes` 注册 `DesktopListPage.routeName`；`StartPage` 改用 `destinationFor(value)`：
  ```dart
  static String destinationFor(DeviceCredential? credential) {
    if (credential == null) return PairingPage.routeName;
    if (credential.mode == ConnectionMode.cloud && credential.desktopId == null) {
      return DesktopListPage.routeName;
    }
    return WorkspacePage.routeName;
  }
  ```
  `build` 里 `Navigator` 不使用路由——现有实现直接返回页面组件；改为 `switch (StartPage.destinationFor(value)) { … return const WorkspacePage(); … }`（保持现有“直接返回页面”的写法）。
- `workspace_page.dart`：`build` 里 `final credential = ref.watch(credentialProvider).value;` 若 `credential?.mode == ConnectionMode.cloud`，AppBar actions 增加 `IconButton(key: Key('cloudDesktopButton'), tooltip: '电脑', icon: Icon(Icons.computer), onPressed: () => Navigator.of(context).pushNamed(DesktopListPage.routeName))`。

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add apps/mobile/lib/features/cloud apps/mobile/lib/main.dart apps/mobile/lib/features/workspaces/workspace_page.dart apps/mobile/lib/features/chat/chat_controller.dart apps/mobile/lib/data/providers.dart apps/mobile/test/features/cloud apps/mobile/test/features/chat/chat_controller_test.dart apps/mobile/test/features/workspaces/workspace_page_test.dart
git commit -m "feat: add cloud desktop list and switching"
```

---

### Task 6: 真 relay 集成核对、使用文档与全量验证

**Files:**
- Create: `apps/mobile/test/cloud/relay_integration_test.dart`
- Create: `docs/cloud-relay-mobile-usage.md`
- Test: 上述集成测试（`RELAY_INTEGRATION=1` 门控，默认跳过）

**Interfaces:**
- Consumes: Task 2 `CloudApi`；`apps/relay` 的 serve/admin CLI（`RELAY_PORT`/`RELAY_HOST`/`RELAY_DATA_DIR`，admin socket 位于 `<RELAY_DATA_DIR>/relay-admin.sock`）。
- 说明：本任务不驱动新生产代码（CloudApi 已由 Task 2 的单元测试 TDD 驱动）；它是**跨实现契约核对**——用真实 relay 验证 Dart 客户端对契约的解读，而非“先写测试再实现”。若它暴露差异，按 systematic-debugging 找出根因，回到 Task 2 补一条失败单元测试再修。

- [ ] **Step 1: 写集成测试**

`apps/mobile/test/cloud/relay_integration_test.dart` 结构：
- `final enabled = Platform.environment['RELAY_INTEGRATION'] == '1';`，`group(..., skip: enabled ? false : 'set RELAY_INTEGRATION=1 运行')`。
- 仓库根：从 `Directory.current` 逐级上溯直到 `File('apps/relay/src/main.ts').existsSync()`，找不到则 `fail('repo root')`。
- 启动 relay：`Process.start('node', ['--import','tsx','apps/relay/src/main.ts'], workingDirectory: root, environment: {...Platform.environment, 'RELAY_HOST':'127.0.0.1','RELAY_PORT':'0','RELAY_DATA_DIR': tempDir.path})`；监听 stdout `utf8.decoder`/`LineSplitter`，解析 `event == 'relay.started'` 的 `port`，20 秒超时；进程提前退出 → 附带 stderr 内容失败。`addTearDown(process.kill)` 与临时目录删除。
- 建号：`Process.run('node', ['--import','tsx','apps/relay/src/cli.ts','admin','create-user', username, '--password', password], workingDirectory: root, environment: {...同上 RELAY_DATA_DIR})`，`exitCode == 0`；`username` 用 `it_<epochMs>` 保证唯一。
- 断言（`baseUrl: 'http://127.0.0.1:$port'`）：
  1. 错误口令 → `CloudApiException` code `INVALID_CREDENTIALS`。
  2. 正确登录 → `contractVersion == 1`、`role == 'phone'`、`deviceId`/`deviceToken` 非空。
  3. `listDesktops` → 空列表（该账号尚无桌面设备）。
  4. `revokeDevice(target: 登录得到的 deviceId)` → 再用同一 deviceId/token 调 `listDesktops` → `UNAUTHENTICATED`（吊销即时生效）。
- 直连 `node` 不存在时：`Process.run('node', ['--version'])` 非 0 → `fail('node 不可用')`（不静默跳过）。

Run: `cd apps/mobile && RELAY_INTEGRATION=1 flutter test test/cloud/relay_integration_test.dart`
Expected: PASS；不带环境变量时该 group 显示 skipped。

- [ ] **Step 2: 写使用文档**

`docs/cloud-relay-mobile-usage.md` 内容（中文，面向内部用户/运维）：
- 前置：relay 已部署、`claude-agent relay login` 已在该电脑完成、管理员已建账号。
- App 侧步骤：配对页 →「使用云端账号登录」→ 填云端地址（如实例 `https://relay.example.com`）、用户名、口令 → 电脑列表 → 选择电脑 → 进入项目列表；切换电脑：项目页右上「电脑」图标；退出：电脑列表页「退出账号」（同时吊销本机在云端的设备记录，不中断电脑上的 run）。
- 与直连的关系：一次只激活一种模式；退出/清除云端凭证后回到配对页可重新扫码直连；直连数据（`recovery.db`）与云端各电脑数据（`recovery-cloud-<desktopId>.db`）互不覆盖。
- 故障对照表：`账号或口令不正确`、`账号已被禁用`、`设备数量已达上限`、`尝试过于频繁`、`无法连接云端`、`登录已失效，请重新登录`、电脑离线（连接状态持续“重连中”，回到列表页确认 `online`）。
- 隐私边界：令牌只在 Keychain；云端只见 TLS 内明文转发内容，事件事实源仍在各电脑。

- [ ] **Step 3: 全量门禁**

Run:
```bash
cd apps/mobile && flutter analyze
cd apps/mobile && flutter test
cd apps/mobile && flutter test --coverage
awk -F: '/^LF:/{lf+=$2} /^LH:/{lh+=$2} END{printf "line coverage: %.1f%%\n", 100*lh/lf}' apps/mobile/coverage/lcov.info
```
Expected: 零告警；全绿；line coverage ≥ 80%。

Run: `cd apps/mobile && RELAY_INTEGRATION=1 flutter test test/cloud/relay_integration_test.dart`
Expected: PASS。

- [ ] **Step 4: 提交并更新待办记录**

```bash
git add apps/mobile/test/cloud docs/cloud-relay-mobile-usage.md
git commit -m "test: verify mobile cloud client against real relay"
```
然后对 claude-mem 列表 `cloud-relay` 的 Plan 3 条目标记 complete。

---

## 自检

- **Spec 覆盖**：设计 §7.3 的四项（云端模式登录、电脑列表与切换、连接层 `desktopId` 路由、直连保留与设置切换）分别落在 Task 3、Task 5、Task 1、Task 3/5；契约 §3.1/3.2/3.4/3.6/§4 由 Task 2 与五处端点拼接覆盖；§7.3「会话缓存按 desktopId 隔离」由 Task 4。
- **步骤扫描**：每个测试步骤给出断言值与文件；每个实现步骤给签名与固定值（错误码、文案、文件名规则）；无“TBD/处理边界情况”这类空步骤。
- **类型一致**：`ConnectionMode`、`DeviceCredential.webSocketUri/httpUri/withDesktop/storageScope`、`CloudApi` 三方法、`DesktopListController` 的方法与 `DesktopListState` 字段在后续任务中按 Task 1/2/5 的 Interfaces 原样引用。
- **Review Focus**：五个输入类各在本任务清单里挂了测试（见上方 Review Focus 各行括注的 Task 编号）。
- **比例**：本计划描述决定与断言，不含完整实现代码；实现体由执行者按签名与测试写。
