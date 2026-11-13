import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:claude_remote/features/chat/voice_input_button.dart';
import 'package:claude_remote/voice/voice_ui_state.dart';

Widget wrap(Widget child) {
  return MaterialApp(home: Scaffold(body: Center(child: child)));
}

void main() {
  testWidgets('labels the hold gesture without saying send', (tester) async {
    await tester.pumpWidget(
      wrap(
        VoiceInputButton(
          state: const VoiceIdle(),
          onPress: () {},
          onRelease: () {},
          onCancel: () {},
        ),
      ),
    );
    expect(find.text('按住说话'), findsOneWidget);
    expect(find.text('发送'), findsNothing);
  });

  testWidgets('shows 松开完成 while recording', (tester) async {
    await tester.pumpWidget(
      wrap(
        VoiceInputButton(
          state: const VoiceRecording(
            asrStreamId: 'asr_1',
            elapsed: Duration.zero,
            partialText: '',
            speechDetected: false,
          ),
          onPress: () {},
          onRelease: () {},
          onCancel: () {},
        ),
      ),
    );
    expect(find.text('松开完成'), findsOneWidget);
  });

  testWidgets('press and release route to the controller', (tester) async {
    var presses = 0;
    var releases = 0;
    await tester.pumpWidget(
      wrap(
        VoiceInputButton(
          state: const VoiceIdle(),
          onPress: () => presses += 1,
          onRelease: () => releases += 1,
          onCancel: () {},
        ),
      ),
    );
    final gesture = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('voice-hold'))),
    );
    await tester.pump();
    expect(find.byKey(const ValueKey('voice-cancel-zone')), findsOneWidget);
    await gesture.up();
    await tester.pump();
    expect(presses, 1);
    expect(releases, 1);
    expect(find.byKey(const ValueKey('voice-cancel-zone')), findsNothing);
  });

  testWidgets('sliding into the cancel zone cancels on release', (
    tester,
  ) async {
    var releases = 0;
    var cancels = 0;
    await tester.pumpWidget(
      wrap(
        VoiceInputButton(
          state: const VoiceIdle(),
          onPress: () {},
          onRelease: () => releases += 1,
          onCancel: () => cancels += 1,
        ),
      ),
    );
    final gesture = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('voice-hold'))),
    );
    await tester.pump();
    await gesture.moveBy(const Offset(0, -80));
    await tester.pump();
    await gesture.up();
    await tester.pump();
    expect(cancels, 1);
    expect(releases, 0);
  });

  testWidgets('keeps pointer-up while state changes to connecting', (
    tester,
  ) async {
    final state = ValueNotifier<VoiceUiState>(const VoiceIdle());
    var releases = 0;
    var cancels = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: ValueListenableBuilder<VoiceUiState>(
              valueListenable: state,
              builder: (context, value, child) {
                return VoiceInputButton(
                  state: value,
                  onPress: () => state.value = const VoiceConnecting(),
                  onRelease: () => releases += 1,
                  onCancel: () => cancels += 1,
                );
              },
            ),
          ),
        ),
      ),
    );
    final gesture = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('voice-hold'))),
    );
    await tester.pump();
    expect(state.value, isA<VoiceConnecting>());
    await gesture.up();
    await tester.pump();
    expect(releases, 1);
    expect(cancels, 0);
  });

  testWidgets('disabled button never starts recording', (tester) async {
    var presses = 0;
    await tester.pumpWidget(
      wrap(
        VoiceInputButton(
          state: const VoiceIdle(),
          enabled: false,
          onPress: () => presses += 1,
          onRelease: () {},
          onCancel: () {},
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('voice-hold')));
    await tester.pump();
    expect(presses, 0);
  });
}