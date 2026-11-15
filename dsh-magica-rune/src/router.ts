/**
 * 极小的 JSON 路由响应辅助。
 * host 侧 handler 直接持有原生 `ServerResponse`，所以必须自己守 `headersSent`。
 * @module dsh-magica-rune/router
 */

import type { ServerResponse } from 'node:http'

/** 写一个 JSON 响应（已发送则跳过）。 */
export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 写一个纯文本响应（已发送则跳过）。 */
export function sendText(res: ServerResponse, status: number, text: string): void {
  if (res.headersSent) return
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' })
  res.end(text)
}

/** 405 + Allow 头。 */
export function sendMethodNotAllowed(res: ServerResponse, allow: string): void {
  if (res.headersSent) return
  res.writeHead(405, { allow, 'content-type': 'text/plain; charset=utf-8' })
  res.end('Method Not Allowed')
}
