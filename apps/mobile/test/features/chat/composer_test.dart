import 'dart:io';

import 'package:claude_remote/features/chat/pending_attachment.dart';
import 'package:claude_remote/features/chat/widgets/composer.dart';
import 'package:claude_remote/voice/voice_ui_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _host(Widget child) => MaterialApp(home: Scaffold(body: child));

void main() {
  testWidgets('toggles between the keyboard and hold-to-talk', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      _host(
        Composer(
          controller: controller,
          enabled: true,
          onChanged: (_) {},
          onSend: () {},
          voiceState: const VoiceIdle(),
          onVoicePress: () {},
          onVoiceRelease: () {},
          onVoiceCancel: () {},
        ),
      ),
    );

    expect(find.byType(TextField), findsOneWidget);

    await tester.tap(find.byKey(const Key('composerVoiceToggle')));
    await tester.pump();

    expect(find.byType(TextField), findsNothing);
    expect(find.text('按住说话'), findsOneWidget);

    await tester.tap(find.byKey(const Key('composerVoiceToggle')));
    await tester.pump();

    expect(find.byType(TextField), findsOneWidget);
  });

  testWidgets('shows a send button only when there is content', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    var sent = 0;
    await tester.pumpWidget(
      _host(
        Composer(
          controller: controller,
          enabled: true,
          onChanged: (_) {},
          onSend: () => sent += 1,
          onPickImage: (_) {},
        ),
      ),
    );

    expect(find.byKey(const Key('composerSend')), findsNothing);
    expect(find.byKey(const Key('composerMore')), findsOneWidget);

    controller.text = '你好';
    await tester.pump();
    expect(find.byKey(const Key('composerSend')), findsOneWidget);
    await tester.tap(find.byKey(const Key('composerSend')));

    expect(sent, 1);
  });

  testWidgets('opens the image sheet from the camera button', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    PhotoSource? picked;
    await tester.pumpWidget(
      _host(
        Composer(
          controller: controller,
          enabled: true,
          onChanged: (_) {},
          onSend: () {},
          onPickImage: (source) => picked = source,
        ),
      ),
    );

    await tester.tap(find.byKey(const Key('composerCamera')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('相册'));
    await tester.pumpAndSettle();

    expect(picked, PhotoSource.gallery);
  });

  testWidgets('shows pending images and removes them', (tester) async {
    final controller = TextEditingController();
    addTearDown(controller.dispose);
    final dir = Directory.systemTemp.createTempSync('s06-composer-');
    final file = File('${dir.path}/a.jpg')
      ..writeAsBytesSync(<int>[0xff, 0xd8, 0xff, 0xe0]);
    addTearDown(() => dir.deleteSync(recursive: true));
    String? removed;
    await tester.pumpWidget(
      _host(
        Composer(
          controller: controller,
          enabled: true,
          onChanged: (_) {},
          onSend: () {},
          attachments: [
            PendingAttachment(
              localPath: file.path,
              size: 4,
              mediaType: 'image/jpeg',
              attachmentId: 'att_12345678',
            ),
          ],
          onRemoveAttachment: (path) => removed = path,
          onPickImage: (_) {},
        ),
      ),
    );

    expect(find.byKey(Key('removeAttachment_${file.path}')), findsOneWidget);

    await tester.tap(find.byKey(Key('removeAttachment_${file.path}')));

    expect(removed, file.path);
  });
}