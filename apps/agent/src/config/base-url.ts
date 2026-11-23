/** 允许的外部接入 URL：https 任意主机；http 仅私有 IPv4（局域网直连）。 */

/** 解析并校验 baseUrl；不合法时抛出安全错误信息。 */
export function parseBaseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('base url must be a valid URL');
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('base url must not contain credentials');
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('base url must not contain query or fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('base url must not contain a path');
  }
  if (url.protocol === 'https:') return url;
  if (url.protocol === 'http:' && isPrivateIpv4(url.hostname)) return url;
  throw new Error(
    'base url must use https, or http on a private LAN address',
  );
}

/** baseUrl 是否满足上述策略。 */
export function isAllowedBaseUrl(raw: string): boolean {
  try {
    parseBaseUrl(raw);
    return true;
  } catch {
    return false;
  }
}

/** 是否为 RFC 1918 / 回环 IPv4 字面量。 */
export function isPrivateIpv4(hostname: string): boolean {
  const parts = hostname.split('.');
  if (parts.length !== 4) return false;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  const [first, second] = octets;
  if (
    first === undefined ||
    second === undefined ||
    octets.some((value) => Number.isNaN(value) || value > 255)
  ) {
    return false;
  }
  if (first === 10 || first === 127) return true;
  if (first === 192 && second === 168) return true;
  return first === 172 && second >= 16 && second <= 31;
}