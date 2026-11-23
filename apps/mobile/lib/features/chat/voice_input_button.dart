import 'package:flutter/material.dart';

import '../../voice/voice_ui_state.dart';

/// 按住说话的长按区；中心文案随录音状态变化，上滑进入取消区后松手取消。
final class VoiceInputButton extends StatefulWidget {
  const VoiceInputButton({
    super.key,
    required this.state,
    required this.onPress,
    required this.onRelease,
    required this.onCancel,
    this.enabled = true,
  });

  final VoiceUiState state;
  final VoidCallback onPress;
  final VoidCallback onRelease;
  final VoidCallback onCancel;
  final bool enabled;

  @override
  State<VoiceInputButton> createState() => _VoiceInputButtonState();
}

class _VoiceInputButtonState extends State<VoiceInputButton> {
  static const double _cancelThreshold = 40;

  bool _holding = false;
  bool _cancelReady = false;
  double _dragUp = 0;

  String get _label {
    final state = widget.state;
    if (state is VoiceRecording) return '松开完成';
    if (state is VoiceConnecting) return '连接中';
    if (state is VoiceFinalizing) return '正在识别';
    return '按住说话';
  }

  @override
  Widget build(BuildContext context) {
    // 只有 idle 才能开始；按住期间的 up/cancel 必须始终保留，
    // 否则状态切到 connecting 后松手会丢失。
    final canPress = widget.enabled && widget.state is VoiceIdle;
    final colors = Theme.of(context).colorScheme;
    final textColor = widget.enabled
        ? colors.onSurface
        : colors.onSurface.withValues(alpha: 0.35);
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (_holding)
          Container(
            key: const ValueKey('voice-cancel-zone'),
            margin: const EdgeInsets.symmetric(vertical: 2),
            width: 132,
            padding: const EdgeInsets.symmetric(vertical: 5),
            decoration: BoxDecoration(
              color: _cancelReady
                  ? colors.errorContainer
                  : colors.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(10),
            ),
            child: Text(
              '松开取消',
              textAlign: TextAlign.center,
              style: TextStyle(
                fontSize: 12,
                color: _cancelReady
                    ? colors.onErrorContainer
                    : colors.onSurfaceVariant,
              ),
            ),
          ),
        Listener(
          key: const ValueKey('voice-hold'),
          onPointerDown: canPress
              ? (_) {
                  setState(() {
                    _holding = true;
                    _cancelReady = false;
                    _dragUp = 0;
                  });
                  widget.onPress();
                }
              : null,
          onPointerMove: (event) {
            if (!_holding) return;
            _dragUp += event.delta.dy;
            final ready = _dragUp < -_cancelThreshold;
            if (ready != _cancelReady) {
              setState(() => _cancelReady = ready);
            }
          },
          onPointerUp: (_) {
            if (!_holding) return;
            final cancelled = _cancelReady;
            setState(() {
              _holding = false;
              _cancelReady = false;
              _dragUp = 0;
            });
            if (cancelled) {
              widget.onCancel();
            } else {
              widget.onRelease();
            }
          },
          onPointerCancel: (_) {
            if (!_holding) return;
            setState(() {
              _holding = false;
              _cancelReady = false;
              _dragUp = 0;
            });
            widget.onCancel();
          },
          child: SizedBox(
            height: 42,
            child: Center(
              child: Text(
                _label,
                style: TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                  color: textColor,
                  letterSpacing: 0.3,
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}