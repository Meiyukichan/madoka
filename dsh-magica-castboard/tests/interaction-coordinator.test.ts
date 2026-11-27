import assert from 'node:assert/strict'
import { test } from 'node:test'

import { InteractionCoordinator } from '../src/host/exec/interaction-coordinator.ts'

interface FakeTimer {
  readonly callback: () => void
  readonly delay: number
}

function fakeTimers(): {
  setTimer: (callback: () => void, delay: number) => unknown
  clearTimer: (handle: unknown) => void
  fire: (delay: number) => void
  size: () => number
} {
  const timers = new Map<number, FakeTimer>()
  let next = 1
  return {
    setTimer(callback, delay) {
      const id = next
      next += 1
      timers.set(id, { callback, delay })
      return id
    },
    clearTimer(handle) {
      timers.delete(handle as number)
    },
    fire(delay) {
      for (const [id, timer] of [...timers]) {
        if (timer.delay !== delay) continue
        timers.delete(id)
        timer.callback()
      }
    },
    size: () => timers.size,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

test('Coordinator：start 立即一拍，wake 去抖，stop 清定时器', async () => {
  const timer = fakeTimers()
  let calls = 0
  const coordinator = new InteractionCoordinator({
    run: async () => { calls += 1 },
    debounceMs: 50,
    safetyMs: 30_000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  })

  coordinator.start()
  assert.equal(calls, 0, 'start 只调度，不阻塞')
  timer.fire(50)
  await flush()
  assert.equal(calls, 1)

  coordinator.wake('added')
  coordinator.wake('added-again')
  assert.equal(timer.size(), 1 + 1, '去抖窗口内只保留一个 wake + 一个 safety')
  timer.fire(50)
  await flush()
  assert.equal(calls, 2)

  coordinator.stop()
  assert.equal(timer.size(), 0)
  timer.fire(30_000)
  await flush()
  assert.equal(calls, 2, 'stop 后不再执行')
})

test('Coordinator：运行中收到 wake 会在当前拍结束后补一拍', async () => {
  const timer = fakeTimers()
  let calls = 0
  let release: (() => void) | undefined
  const gate = new Promise<void>(resolve => { release = resolve })
  const coordinator = new InteractionCoordinator({
    run: async () => {
      calls += 1
      await gate
    },
    debounceMs: 0,
    safetyMs: 60_000,
    setTimer: timer.setTimer,
    clearTimer: timer.clearTimer,
  })

  coordinator.start()
  timer.fire(0)
  await flush()
  assert.equal(calls, 1)

  // The first pass is still blocked; this wake only marks `dirty`.
  coordinator.wake('during')
  timer.fire(0)
  await flush()
  assert.equal(calls, 1)

  release?.()
  await flush()
  assert.equal(calls, 2, 'running + dirty => one extra pass')
  coordinator.stop()
})
