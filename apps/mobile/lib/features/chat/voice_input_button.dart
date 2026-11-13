import 'package:flutter/material.dart';

import '../../voice/voice_ui_state.dart';

/// 按住说话按钮；滑入取消区松手即取消。
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
    final disabled =
        !widget.enabled ||
        widget.state is VoiceConnecting ||
        widget.state is VoiceFinalizing;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (_holding)
          Container(
            key: const ValueKey('voice-cancel-zone'),
            width: 200,
            padding: const EdgeInsets.all(6),
            decoration: BoxDecoration(
              color: _cancelReady
                  ? Theme.of(context).colorScheme.errorContainer
                  : Theme.of(context).colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Text(
              '松开取消',
              textAlign: TextAlign.center,
              style: TextStyle(
                color: _cancelReady
                    ? Theme.of(context).colorScheme.onErrorContainer
                    : null,
              ),
            ),
          ),
        Listener(
          key: const ValueKey('voice-hold'),
          onPointerDown: disabled
              ? null
              : (_) {
                  setState(() {
                    _holding = true;
                    _cancelReady = false;
                    _dragUp = 0;
                  });
                  widget.onPress();
                },
          onPointerMove: disabled
              ? null
              : (event) {
                  _dragUp += event.delta.dy;
                  final ready = _dragUp < -_cancelThreshold;
                  if (ready != _cancelReady) {
                    setState(() => _cancelReady = ready);
                  }
                },
          onPointerUp: disabled
              ? null
              : (_) {
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
          onPointerCancel: disabled
              ? null
              : (_) {
                  setState(() {
                    _holding = false;
                    _cancelReady = false;
                    _dragUp = 0;
                  });
                  widget.onCancel();
                },
          child: FilledButton.tonalIcon(
            onPressed: disabled ? null : () {},
            icon: const Icon(Icons.mic),
            label: Text(_label),
          ),
        ),
      ],
    );
  }
}