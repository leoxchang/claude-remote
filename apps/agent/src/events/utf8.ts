/** 按 UTF-8 字节截断文本，绝不切断多字节字符。 */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };

  let end = maxBytes;
  while (end > 0) {
    const byte = bytes[end] ?? 0;
    const isContinuation = byte >= 0x80 && byte < 0xc0;
    if (!isContinuation) break;
    end -= 1;
  }
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}