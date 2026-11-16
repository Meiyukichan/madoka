import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, describe, it } from 'node:test'
import {
  isMagicaSession,
  noteMagicaSession,
  resetMagicaSessionCache,
} from '../../src/interactions/ownership.ts'
import { getSessionStore, resetSessionStores } from '../../src/sessions/store.ts'
import { fakeCtx } from '../helpers/fake.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-own-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  resetSessionStores()
})

let dir = ''
let ctx = fakeCtx()

function seed(sessionId: string): void {
  const store = getSessionStore(fakeCtx({ dshHomePath: (...segments: string[]) => join(dir, ...segments) }), dir)
  assert.ok(store !== null)
  store.put({ sessionId, kind: 'workspace', createdAt: 1, workspaceId: 'w', workspacePath: 'D:/w' })
}

beforeEach(() => {
  dir = tempDir()
  ctx = fakeCtx()
  resetSessionStores()
  resetMagicaSessionCache()
})

describe('isMagicaSession', () => {
  it('台账命中 → true；未命中 → false', () => {
    seed('s1')
    assert.equal(isMagicaSession(ctx, 's1', dir), true)
    assert.equal(isMagicaSession(ctx, 'nope', dir), false)
  })

  it('正结果**不缓存**：台账被删后立刻变 false（D-054/E-018 回归）', () => {
    seed('s2')
    assert.equal(isMagicaSession(ctx, 's2', dir), true)
    const store = getSessionStore(fakeCtx({ dshHomePath: (...segments: string[]) => join(dir, ...segments) }), dir)
    assert.ok(store !== null)
    assert.equal(store.remove('s2'), true)
    assert.equal(isMagicaSession(ctx, 's2', dir), false, '不能因为上次命中就一直认')
  })

  it('负结果走缓存：台账后来出现时，需要 noteMagicaSession 才认', () => {
    assert.equal(isMagicaSession(ctx, 's3', dir), false)
    seed('s3')
    // 负缓存命中：仍然 false（这正是门面写完台账要调用 noteMagicaSession 的原因）
    assert.equal(isMagicaSession(ctx, 's3', dir), false)
    noteMagicaSession('s3', dir)
    assert.equal(isMagicaSession(ctx, 's3', dir), true)
  })

  it('noteMagicaSession 在白名单里就认（即使台账写失败/无文件）', () => {
    noteMagicaSession('s4', dir)
    assert.equal(isMagicaSession(ctx, 's4', dir), true)
  })

  it('不同 storeDir 的同一个 id 互不影响', () => {
    seed('s5')
    assert.equal(isMagicaSession(ctx, 's5', dir), true)
    assert.equal(isMagicaSession(ctx, 's5', join(dir, 'other')), false)
  })

  it('resetMagicaSessionCache 后回到"全靠台账"', () => {
    seed('s6')
    assert.equal(isMagicaSession(ctx, 's6', dir), true)
    resetMagicaSessionCache()
    assert.equal(isMagicaSession(ctx, 's6', dir), true, '台账还在就是命中')
  })
})
