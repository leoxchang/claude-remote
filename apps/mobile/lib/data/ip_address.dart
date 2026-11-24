/// 仅本机/私有网段的 IPv4；用于允许明文 http 的开发场景。
///
/// 与配对二维码的地址规则共用：https 任意主机，http 只限内网。
bool isPrivateIpv4(String host) {
  final parts = host.split('.');
  if (parts.length != 4) return false;
  final octets = <int>[];
  for (final part in parts) {
    if (!RegExp(r'^\d{1,3}$').hasMatch(part)) return false;
    final value = int.tryParse(part);
    if (value == null || value > 255) return false;
    octets.add(value);
  }
  final first = octets[0];
  final second = octets[1];
  if (first == 10 || first == 127) return true;
  if (first == 192 && second == 168) return true;
  return first == 172 && second >= 16 && second <= 31;
}
