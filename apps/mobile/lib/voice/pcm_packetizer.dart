import 'dart:typed_data';

/// 标准音频包：200 ms / 6,400 bytes。
const int pcmPacketBytes = 6400;

/// 把任意大小的 PCM16 chunk 拆成 6,400-byte 帧，绝不拆分 16-bit sample。
final class PcmPacketizer {
  PcmPacketizer({this.packetBytes = pcmPacketBytes})
    : assert(packetBytes > 0 && packetBytes.isEven);

  final int packetBytes;
  final List<int> _buffer = [];
  int? _pendingByte;

  /// 追加一块 PCM；返回所有凑满的帧。
  List<Uint8List> add(Uint8List chunk) {
    final pending = _pendingByte;
    if (pending != null) {
      _buffer.add(pending);
      _pendingByte = null;
    }
    _buffer.addAll(chunk);
    if (_buffer.length.isOdd) {
      _pendingByte = _buffer.removeLast();
    }
    final frames = <Uint8List>[];
    var offset = 0;
    while (_buffer.length - offset >= packetBytes) {
      frames.add(
        Uint8List.fromList(
          _buffer.sublist(offset, offset + packetBytes),
        ),
      );
      offset += packetBytes;
    }
    if (offset > 0) _buffer.removeRange(0, offset);
    return frames;
  }

  /// 返回不足一帧的偶数长度残余；只有半样本或为空时返回 null。
  Uint8List? flush() {
    if (_buffer.isEmpty) return null;
    final bytes = Uint8List.fromList(_buffer);
    _buffer.clear();
    return bytes;
  }
}