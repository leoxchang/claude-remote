/** 默认标题：本机时间 `会话 YYYY-MM-DD HH:mm`，允许重名。 */
export function defaultSessionTitle(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return [
    `会话 ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    `${pad(now.getHours())}:${pad(now.getMinutes())}`,
  ].join(' ');
}