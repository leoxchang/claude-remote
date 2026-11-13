import 'dart:math' as math;
import 'dart:typed_data';

/// 静音与空输入的 dBFS 下限。
const double silenceDbfs = -96;

/// 计算 PCM16 little-endian 的 RMS 音量（dBFS）。
double rmsDbfsPcm16(Uint8List pcm) {
  if (pcm.length < 2) return silenceDbfs;
  final samples = pcm.length ~/ 2;
  final data = ByteData.sublistView(pcm);
  var sum = 0.0;
  for (var index = 0; index < samples; index += 1) {
    final sample = data.getInt16(index * 2, Endian.little) / 32768;
    sum += sample * sample;
  }
  final rms = math.sqrt(sum / samples);
  if (rms <= 0) return silenceDbfs;
  return math.max(silenceDbfs, 20 * math.log(rms) / math.ln10);
}