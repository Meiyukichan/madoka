/**
 * 回环判定：本服务的安全模型是「只在本机跑」，所以绑定点必须限定回环。
 *
 * 两个不同概念，别混用：
 *  - `isLoopbackHost(host)`：启动时校验 `--host`（可能是主机名或 IP 字面量）
 *  - `isLoopbackAddress(ip)`：请求方来源 IP 判定（可能带 `::ffff:` 前缀）
 */

/** `--host` 允许的取值：127.0.0.0/8、::1、localhost */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  if (h === '') return false
  if (h === 'localhost') return true
  // IPv6 回环（允许带方括号）
  if (h === '::1' || h === '[::1]') return true
  // IPv4 127.0.0.0/8
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (!v4) return false
  const octets = v4.slice(1).map((x) => Number(x))
  if (octets.some((n) => n < 0 || n > 255)) return false
  return octets[0] === 127
}

/** 请求来源 IP 是否回环 */
export function isLoopbackAddress(ip: string): boolean {
  const v = ip.trim().toLowerCase()
  if (v === '::1' || v === '127.0.0.1') return true
  // 双栈下 IPv4 映射成 ::ffff:127.0.0.1
  if (v.startsWith('::ffff:')) return isLoopbackAddress(v.slice('::ffff:'.length))
  return v.startsWith('127.')
}
