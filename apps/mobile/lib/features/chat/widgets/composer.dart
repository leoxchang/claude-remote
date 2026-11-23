import 'dart:io';
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../../../voice/voice_ui_state.dart';
import '../pending_attachment.dart';
import '../voice_input_button.dart';

/// 底部输入条：图片、语音与键盘三种输入共用一个悬浮胶囊。
///
/// 键盘模式显示文本框；语音模式显示“按住说话”。两者由右侧圆形按钮切换，
/// 左侧相机与右侧“+”都能打开图片选择。
class Composer extends StatefulWidget {
  const Composer({
    super.key,
    required this.controller,
    required this.enabled,
    required this.onChanged,
    required this.onSend,
    this.label = '发送',
    this.readOnly = false,
    this.attachments = const <PendingAttachment>[],
    this.onRemoveAttachment,
    this.onPickImage,
    this.attachmentsBusy = false,
    this.voiceState,
    this.onVoicePress,
    this.onVoiceRelease,
    this.onVoiceCancel,
    this.canRecordVoice = false,
  });

  final TextEditingController controller;
  final bool enabled;
  final ValueChanged<String> onChanged;
  final VoidCallback onSend;
  final String label;
  final bool readOnly;
  final List<PendingAttachment> attachments;
  final ValueChanged<String>? onRemoveAttachment;
  final ValueChanged<PhotoSource>? onPickImage;

  /// 有图片正在上传；发送按钮显示为不可用。
  final bool attachmentsBusy;
  final VoiceUiState? voiceState;
  final VoidCallback? onVoicePress;
  final VoidCallback? onVoiceRelease;
  final VoidCallback? onVoiceCancel;
  final bool canRecordVoice;

  @override
  State<Composer> createState() => _ComposerState();
}

class _ComposerState extends State<Composer> {
  static const String _hint = '发消息或按住说话…';

  bool _voiceMode = false;

  bool get _hasContent =>
      widget.controller.text.trim().isNotEmpty || widget.attachments.isNotEmpty;

  @override
  void initState() {
    super.initState();
    widget.controller.addListener(_onTextChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onTextChanged);
    super.dispose();
  }

  /// 草稿可能由语音或外部逻辑写入，输入条需要自行刷新。
  void _onTextChanged() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(Composer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(_onTextChanged);
      widget.controller.addListener(_onTextChanged);
    }
    // 语音识别结束后把结果交回键盘模式，方便直接编辑或发送。
    final wasActive = oldWidget.voiceState is! VoiceIdle;
    if (wasActive &&
        widget.voiceState is VoiceIdle &&
        widget.controller.text.trim().isNotEmpty) {
      _voiceMode = false;
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final voiceState = widget.voiceState;
    final canToggleVoice = voiceState != null && widget.onVoicePress != null;
    final showVoiceBar = _voiceMode && canToggleVoice;
    final surface = theme.brightness == Brightness.dark
        ? colors.surfaceContainerHigh
        : Colors.white;
    return SafeArea(
      top: false,
      child: Padding(
        padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (widget.attachments.isNotEmpty) _attachmentsBar(colors),
            Container(
              constraints: const BoxConstraints(minHeight: 56),
              padding: const EdgeInsets.symmetric(horizontal: 8),
              decoration: BoxDecoration(
                color: surface,
                borderRadius: BorderRadius.circular(28),
                border: Border.all(
                  color: colors.outlineVariant.withValues(alpha: 0.5),
                  width: 0.5,
                ),
                boxShadow: [
                  BoxShadow(
                    color: Colors.black.withValues(alpha: 0.05),
                    blurRadius: 14,
                    offset: const Offset(0, 4),
                  ),
                ],
              ),
              child: Row(
                children: [
                  if (widget.onPickImage != null)
                    _FlatIconButton(
                      key: const Key('composerCamera'),
                      tooltip: '拍照或选择图片',
                      onPressed: widget.readOnly
                          ? null
                          : () => _pickImage(context),
                      icon: const Icon(Icons.photo_camera_outlined, size: 27),
                    ),
                  Expanded(
                    child: showVoiceBar
                        ? VoiceInputButton(
                            state: voiceState,
                            enabled: widget.enabled && widget.canRecordVoice,
                            onPress: widget.onVoicePress!,
                            onRelease: widget.onVoiceRelease ?? () {},
                            onCancel: widget.onVoiceCancel ?? () {},
                          )
                        : Padding(
                            padding: const EdgeInsets.symmetric(horizontal: 4),
                            child: TextField(
                              controller: widget.controller,
                              onChanged: widget.onChanged,
                              readOnly: widget.readOnly,
                              minLines: 1,
                              maxLines: 5,
                              style: TextStyle(
                                fontSize: 16.5,
                                height: 1.3,
                                color: colors.onSurface,
                              ),
                              cursorColor: colors.primary,
                              decoration: InputDecoration(
                                hintText: _hint,
                                hintStyle: TextStyle(
                                  fontSize: 16.5,
                                  color: colors.onSurface.withValues(
                                    alpha: 0.4,
                                  ),
                                ),
                                border: InputBorder.none,
                                isDense: true,
                                contentPadding: const EdgeInsets.symmetric(
                                  vertical: 14,
                                ),
                              ),
                            ),
                          ),
                  ),
                  if (canToggleVoice)
                    _CircleGlyphButton(
                      key: const Key('composerVoiceToggle'),
                      tooltip: showVoiceBar ? '切换到键盘' : '切换到语音',
                      glyph: showVoiceBar
                          ? _Glyph.keyboard
                          : _Glyph.voice,
                      onPressed: widget.readOnly
                          ? null
                          : () => _toggleVoice(!showVoiceBar),
                    ),
                  _trailing(context),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _trailing(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final canSendNow =
        widget.enabled && _hasContent && !widget.attachmentsBusy;
    if (_hasContent || widget.attachmentsBusy) {
      return Padding(
        padding: const EdgeInsets.only(left: 2, right: 2),
        child: Tooltip(
          message: widget.label,
          child: InkResponse(
            key: const Key('composerSend'),
            onTap: canSendNow ? widget.onSend : null,
            radius: 24,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 150),
              width: 36,
              height: 36,
              decoration: BoxDecoration(
                color: canSendNow ? colors.primary : colors.primary.withValues(
                  alpha: 0.25,
                ),
                shape: BoxShape.circle,
              ),
              child: Icon(
                Icons.arrow_upward_rounded,
                size: 20,
                color: colors.onPrimary,
              ),
            ),
          ),
        ),
      );
    }
    if (widget.onPickImage == null) return const SizedBox(width: 4);
    return _CircleGlyphButton(
      key: const Key('composerMore'),
      tooltip: '更多',
      glyph: _Glyph.plus,
      onPressed: widget.readOnly ? null : () => _pickImage(context),
    );
  }

  Widget _attachmentsBar(ColorScheme colors) {
    return SizedBox(
      height: 76,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 6),
        itemCount: widget.attachments.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) {
          final attachment = widget.attachments[index];
          return Stack(
            children: [
              ClipRRect(
                borderRadius: BorderRadius.circular(10),
                child: Image.file(
                  File(attachment.localPath),
                  width: 64,
                  height: 64,
                  fit: BoxFit.cover,
                  errorBuilder: (_, _, _) => Container(
                    width: 64,
                    height: 64,
                    color: colors.surfaceContainerHighest,
                    child: const Icon(Icons.broken_image_outlined),
                  ),
                ),
              ),
              if (!attachment.isReady)
                Positioned.fill(
                  child: Container(
                    decoration: BoxDecoration(
                      color: colors.scrim.withValues(alpha: 0.4),
                      borderRadius: BorderRadius.circular(10),
                    ),
                    child: const Center(
                      child: SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      ),
                    ),
                  ),
                ),
              if (widget.onRemoveAttachment != null)
                Positioned(
                  top: 0,
                  right: 0,
                  child: GestureDetector(
                    key: Key('removeAttachment_${attachment.localPath}'),
                    onTap: () =>
                        widget.onRemoveAttachment!(attachment.localPath),
                    child: Container(
                      decoration: BoxDecoration(
                        color: colors.scrim.withValues(alpha: 0.6),
                        shape: BoxShape.circle,
                      ),
                      padding: const EdgeInsets.all(2),
                      child: const Icon(
                        Icons.close,
                        size: 14,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
            ],
          );
        },
      ),
    );
  }

  void _toggleVoice(bool enabled) {
    setState(() => _voiceMode = enabled);
    if (enabled) FocusScope.of(context).unfocus();
  }

  Future<void> _pickImage(BuildContext context) async {
    final onPick = widget.onPickImage;
    if (onPick == null) return;
    FocusScope.of(context).unfocus();
    final source = await showModalBottomSheet<PhotoSource>(
      context: context,
      builder: (sheetContext) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera_outlined),
              title: const Text('拍照'),
              onTap: () => Navigator.of(sheetContext).pop(PhotoSource.camera),
            ),
            ListTile(
              leading: const Icon(Icons.photo_library_outlined),
              title: const Text('相册'),
              onTap: () => Navigator.of(sheetContext).pop(PhotoSource.gallery),
            ),
          ],
        ),
      ),
    );
    if (source != null && mounted) onPick(source);
  }
}

/// 无底色的大图标按钮；用于相机入口。
class _FlatIconButton extends StatelessWidget {
  const _FlatIconButton({
    super.key,
    required this.tooltip,
    required this.onPressed,
    required this.icon,
  });

  final String tooltip;
  final VoidCallback? onPressed;
  final Widget icon;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: tooltip,
      child: InkResponse(
        onTap: onPressed,
        radius: 22,
        child: SizedBox(
          width: 42,
          height: 42,
          child: IconTheme(
            data: IconThemeData(
              color: Theme.of(context).colorScheme.onSurface,
            ),
            child: icon,
          ),
        ),
      ),
    );
  }
}

/// 圆形描边图标按钮；对应参考图右侧的语音切换与加号。
class _CircleGlyphButton extends StatelessWidget {
  const _CircleGlyphButton({
    super.key,
    required this.tooltip,
    required this.glyph,
    required this.onPressed,
  });

  final String tooltip;
  final _Glyph glyph;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Tooltip(
      message: tooltip,
      child: InkResponse(
        onTap: onPressed,
        radius: 22,
        child: SizedBox(
          width: 40,
          height: 40,
          child: Center(
            child: CustomPaint(
              size: const Size(27, 27),
              painter: _GlyphPainter(
                glyph,
                onPressed == null
                    ? colors.onSurface.withValues(alpha: 0.3)
                    : colors.onSurface,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

enum _Glyph { voice, keyboard, plus }

/// 手绘图标：语音、切换键盘、加号；外圈统一为 1.4pt 描边。
class _GlyphPainter extends CustomPainter {
  const _GlyphPainter(this.glyph, this.color);

  final _Glyph glyph;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final center = Offset(size.width / 2, size.height / 2);
    final stroke = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.5
      ..strokeCap = StrokeCap.round;
    final fill = Paint()
      ..color = color
      ..style = PaintingStyle.fill;
    canvas.drawCircle(center, size.width / 2 - 1, stroke);
    switch (glyph) {
      case _Glyph.voice:
        canvas.drawCircle(center, 2.1, fill);
        for (final radius in const [6.0, 9.2]) {
          canvas.drawArc(
            Rect.fromCircle(center: center, radius: radius),
            -math.pi / 4,
            math.pi / 2,
            false,
            stroke,
          );
          canvas.drawArc(
            Rect.fromCircle(center: center, radius: radius),
            math.pi * 3 / 4,
            math.pi / 2,
            false,
            stroke,
          );
        }
        break;
      case _Glyph.keyboard:
        for (final dx in const [-6.0, 0.0, 6.0]) {
          canvas.drawCircle(center + Offset(dx, -5.2), 1.5, fill);
        }
        canvas.drawCircle(center + const Offset(-6, 5.2), 1.5, fill);
        canvas.drawCircle(center + const Offset(6, 5.2), 1.5, fill);
        canvas.drawLine(
          center + const Offset(-2.6, 5.2),
          center + const Offset(2.6, 5.2),
          stroke,
        );
        break;
      case _Glyph.plus:
        canvas.drawLine(
          center + const Offset(-5.5, 0),
          center + const Offset(5.5, 0),
          stroke,
        );
        canvas.drawLine(
          center + const Offset(0, -5.5),
          center + const Offset(0, 5.5),
          stroke,
        );
        break;
    }
  }

  @override
  bool shouldRepaint(_GlyphPainter oldDelegate) =>
      oldDelegate.glyph != glyph || oldDelegate.color != color;
}