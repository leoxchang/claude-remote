import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:claude_remote/data/cloud_api.dart';
import 'package:flutter_test/flutter_test.dart';

/// 跨实现契约核对：用真实 relay 验证 Dart 客户端的契约解读。
///
/// 默认跳过；`RELAY_INTEGRATION=1 flutter test test/cloud/relay_integration_test.dart` 运行。
void main() {
  final enabled = Platform.environment['RELAY_INTEGRATION'] == '1';

  group('mobile client against the real relay', () {
    late Directory repoRoot;
    late Directory dataDir;
    late Process relay;
    late int port;
    late String username;
    late String password;

    setUpAll(() async {
      repoRoot = _repositoryRoot();
      dataDir = await Directory.systemTemp.createTemp('relay-it-');
      username = 'it_${DateTime.now().millisecondsSinceEpoch}';
      password = 'it-password-1';

      final process = await Process.start(
        'node',
        ['--import', 'tsx', 'apps/relay/src/main.ts'],
        workingDirectory: repoRoot.path,
        environment: {
          ...Platform.environment,
          'RELAY_HOST': '127.0.0.1',
          'RELAY_PORT': '0',
          'RELAY_DATA_DIR': dataDir.path,
        },
      );
      final stderrBuffer = StringBuffer();
      process.stderr.listen((chunk) => stderrBuffer.write(utf8.decode(chunk)));
      port = await _startedPort(
        process,
        stderrBuffer,
      ).timeout(
        const Duration(seconds: 30),
        onTimeout: () {
          process.kill();
          throw StateError('relay 未启动: $stderrBuffer');
        },
      );
      relay = process;
      await _createUser(repoRoot, dataDir, username, password);
    });

    tearDownAll(() async {
      relay.kill();
      await dataDir.delete(recursive: true);
    });

    test('login, list and revocation follow the contract', () async {
      final api = CloudApi();
      final baseUrl = 'http://127.0.0.1:$port';

      await expectLater(
        api.login(
          baseUrl: baseUrl,
          username: username,
          password: 'wrong-password',
          deviceName: 'iPhone',
          platform: 'ios',
          appVersion: '1.0.0',
        ),
        throwsA(
          isA<CloudApiException>().having(
            (error) => error.code,
            'code',
            'INVALID_CREDENTIALS',
          ),
        ),
      );

      final login = await api.login(
        baseUrl: baseUrl,
        username: username,
        password: password,
        deviceName: 'iPhone',
        platform: 'ios',
        appVersion: '1.0.0',
      );
      expect(login.contractVersion, 1);
      expect(login.role, 'phone');
      expect(login.deviceId, isNotEmpty);
      expect(login.deviceToken, isNotEmpty);

      final desktops = await api.listDesktops(
        baseUrl: baseUrl,
        deviceId: login.deviceId,
        deviceToken: login.deviceToken,
      );
      expect(desktops, isEmpty);

      await api.revokeDevice(
        baseUrl: baseUrl,
        deviceId: login.deviceId,
        deviceToken: login.deviceToken,
        targetDeviceId: login.deviceId,
      );
      await expectLater(
        api.listDesktops(
          baseUrl: baseUrl,
          deviceId: login.deviceId,
          deviceToken: login.deviceToken,
        ),
        throwsA(
          isA<CloudApiException>().having(
            (error) => error.code,
            'code',
            'UNAUTHENTICATED',
          ),
        ),
      );
    }, timeout: const Timeout(Duration(minutes: 2)));
  }, skip: enabled ? false : '设置 RELAY_INTEGRATION=1 运行');
}

/// 从当前目录上溯到含 `apps/relay/src/main.ts` 的仓库根。
Directory _repositoryRoot() {
  var dir = Directory.current.absolute;
  while (true) {
    if (File('${dir.path}/apps/relay/src/main.ts').existsSync()) return dir;
    final parent = dir.parent;
    if (parent.path == dir.path) {
      fail('找不到仓库根（apps/relay/src/main.ts）');
    }
    dir = parent;
  }
}

/// 读取 relay 启动事件里的端口；进程提前退出时带 stderr 失败。
Future<int> _startedPort(Process process, StringBuffer stderrBuffer) {
  final completer = Completer<int>();
  process.stdout
      .transform(utf8.decoder)
      .transform(const LineSplitter())
      .listen((line) {
        if (completer.isCompleted) return;
        final Object? decoded;
        try {
          decoded = jsonDecode(line);
        } on FormatException {
          return;
        }
        if (decoded is Map && decoded['event'] == 'relay.started') {
          final port = decoded['port'];
          if (port is int) completer.complete(port);
        }
      });
  unawaited(
    process.exitCode.then((code) {
      if (!completer.isCompleted) {
        completer.completeError(
          StateError('relay 提前退出（$code）: $stderrBuffer'),
        );
      }
    }),
  );
  return completer.future;
}

Future<void> _createUser(
  Directory repoRoot,
  Directory dataDir,
  String username,
  String password,
) async {
  final result = await Process.run(
    'node',
    [
      'apps/relay/bin/claude-remote-relay.js',
      'admin',
      'create-user',
      username,
      '--password',
      password,
    ],
    workingDirectory: repoRoot.path,
    environment: {...Platform.environment, 'RELAY_DATA_DIR': dataDir.path},
  );
  if (result.exitCode != 0) {
    fail('admin create-user 失败: ${result.stderr}');
  }
}
