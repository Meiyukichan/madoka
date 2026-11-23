/**
 * 日志契约：host 事件只走 spellbook 的 logEvent，绝不污染 dsh web 的终端。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { eventLog } from '../src/host/shared/event-log.ts'

test('eventLog：info/warn/error 都不写 console', () => {
  const original = { info: console.info, warn: console.warn, error: console.error }
  const seen: string[] = []
  console.info = () => { seen.push('info') }
  console.warn = () => { seen.push('warn') }
  console.error = () => { seen.push('error') }
  try {
    eventLog('info', 'test-info', 'detail')
    eventLog('warn', 'test-warn', 'detail')
    eventLog('error', 'test-error', 'detail')
  } finally {
    console.info = original.info
    console.warn = original.warn
    console.error = original.error
  }
  assert.deepEqual(seen, [])
})
