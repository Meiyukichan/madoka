/**
 * `domain` 配置的解析与格式化：本机写 `127.0.0.1:3939`，线上写 `xxx.com`（不写端口）。
 *
 * 约定：
 * - 显式 `http://` / `https://` 原样保留；
 * - 回环地址缺省 `http`，其它主机缺省 `https`；
 * - 线上不写端口时就是 443，不补 `:443`。
 *
 * @module dsh-teamwork/shared/domain
 */

export interface DomainParts {
  /** 原始（去掉首尾空白）。 */
  raw: string
  host: string
  /** 显式端口；线上未写端口时为 null。 */
  port: number | null
  scheme: 'http' | 'https'
}

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase()
  return h === 'localhost' || h === '::1' || h === '127.0.0.1' || h.startsWith('127.')
}

/** 解析 `domain`；非法输入返回 null，由调用方决定回退。 */
export function parseDomain(raw: string): DomainParts | null {
  const text = raw.trim().replace(/\/+$/, '')
  if (text === '') return null

  if (/^https?:\/\//i.test(text)) {
    try {
      const url = new URL(text)
      const scheme = url.protocol === 'https:' ? 'https' : 'http'
      const port = url.port === '' ? null : Number(url.port)
      if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null
      return { raw: text, host: url.hostname, port, scheme }
    } catch {
      return null
    }
  }

  // 无 scheme：只接受 authority（host / host:port / [::1]:port）。
  const authority = text.split('/')[0] ?? ''
  if (authority === '') return null
  let host = authority
  let portText: string | null = null
  if (authority.startsWith('[')) {
    const end = authority.indexOf(']')
    if (end < 0) return null
    host = authority.slice(0, end + 1)
    const rest = authority.slice(end + 1)
    if (rest !== '') {
      if (!rest.startsWith(':')) return null
      portText = rest.slice(1)
    }
  } else {
    const colon = authority.lastIndexOf(':')
    if (colon >= 0) {
      host = authority.slice(0, colon)
      portText = authority.slice(colon + 1)
    }
  }
  if (host === '') return null
  const scheme: 'http' | 'https' = isLoopbackHost(host) ? 'http' : 'https'
  const port = portText === null ? null : Number(portText)
  if (port !== null && (!Number.isInteger(port) || port < 1 || port > 65535)) return null
  return { raw: text, host, port, scheme }
}

/** 写回配置：本机保留端口，线上 80/443 省略端口。 */
export function formatDomain(host: string, port: number | null): string {
  const bracketed = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host
  if (port === null || port === 80 || port === 443) return bracketed
  return `${bracketed}:${port}`
}
