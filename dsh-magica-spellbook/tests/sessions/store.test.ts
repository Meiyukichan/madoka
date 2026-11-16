import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import {
  SAFE_ID,
  STORE_VERSION,
  SessionRecordStore,
  recordFileName,
  resetSessionStores,
} from '../../src/sessions/store.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-store-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  resetSessionStores()
})

describe('recordFileName', () => {
  it('允许的字符集与长度', () => {
    assert.equal(recordFileName('abc-1_2.3'), 'abc-1_2.3.json')
    assert.match(SAFE_ID.source, /\^\[A-Za-z0-9\._-\]/)
  })

  it('非法 id 抛错并给出允许字符', () => {
    assert.throws(() => recordFileName('bad/id'), /is not usable as a store file name/)
    assert.throws(() => recordFileName('a'.repeat(201)), /length 1-200/)
  })
})

describe('SessionRecordStore', () => {
  it('put 原子写：2 空格缩进 + 末尾换行，且能读回', () => {
    const dir = tempDir()
    const store = new SessionRecordStore(dir)
    store.put({ sessionId: 's1', kind: 'workspace', createdAt: 1 })
    const text = readFileSync(join(dir, 's1.json'), 'utf8')
    assert.match(text, /^\{\n {2}"sessionId": "s1",/)
    assert.ok(text.endsWith('\n'))
    assert.equal(store.get('s1')?.sessionId, 's1')
    assert.equal(store.get('s1')?.version, STORE_VERSION)
  })

  it('get 未命中返回 null（ENOENT 不记 loadErrors）', () => {
    const dir = tempDir()
    const store = new SessionRecordStore(dir)
    assert.equal(store.get('missing'), null)
    assert.equal(store.loadErrors.length, 0)
  })

  it('版本比本 build 新 → 跳过并记一条错误', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'future.json'),
      JSON.stringify({ version: 99, sessionId: 'future', kind: 'workspace', createdAt: 1, updatedAt: 1 }),
      'utf8',
    )
    const store = new SessionRecordStore(dir)
    assert.equal(store.get('future'), null)
    assert.match(store.loadErrors[0]?.message ?? '', /newer than this build supports/)
  })

  it('缺 sessionId / kind → not a session record', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.json'), JSON.stringify({ version: 1 }), 'utf8')
    const store = new SessionRecordStore(dir)
    assert.equal(store.get('broken'), null)
    assert.match(store.loadErrors[0]?.message ?? '', /not a session record/)
  })

  it('remove 先删盘再删缓存；文件不在时也返回 false', () => {
    const dir = tempDir()
    const store = new SessionRecordStore(dir)
    store.put({ sessionId: 's2', kind: 'ephemeral', createdAt: 1, cwd: 'D:/tmp' })
    assert.equal(store.remove('s2'), true)
    assert.equal(store.get('s2'), null)
    assert.equal(store.remove('s2'), false)
  })

  it('list 按 createdAt 降序', () => {
    const dir = tempDir()
    const store = new SessionRecordStore(dir)
    store.put({ sessionId: 'a', kind: 'workspace', createdAt: 1 })
    store.put({ sessionId: 'b', kind: 'workspace', createdAt: 3 })
    store.put({ sessionId: 'c', kind: 'workspace', createdAt: 2 })
    assert.deepEqual(store.list().map((record) => record.sessionId), ['b', 'c', 'a'])
  })

  it('可选字段为空字符串时不落库', () => {
    const dir = tempDir()
    const store = new SessionRecordStore(dir)
    const stored = store.put({ sessionId: 's3', kind: 'workspace', createdAt: 1, title: '' })
    assert.equal(stored.title, '')
    // 读回时 asRecord 会丢掉空串
    assert.equal(new SessionRecordStore(dir).get('s3')?.title, undefined)
  })
})

describe('SessionRecordStore · 补充契约', () => {
  it('put 覆盖同一 id：保留 createdAt、推进 updatedAt、version 恒为 STORE_VERSION', () => {
    const dir = tempDir()
    const store = new SessionRecordStore(dir)
    const first = store.put({ sessionId: 'ov', kind: 'workspace', createdAt: 1000 })
    const second = store.put({ sessionId: 'ov', kind: 'workspace', createdAt: 1000, title: 'T' })
    assert.equal(second.createdAt, 1000)
    assert.equal(second.version, STORE_VERSION)
    assert.ok((second.updatedAt ?? 0) >= (first.updatedAt ?? 0))
    assert.equal(store.get('ov')?.title, 'T')
  })

  it('损坏的 JSON → null + loadErrors（不抛）', () => {
    const dir = tempDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken-json.json'), '{ not json', 'utf8')
    const store = new SessionRecordStore(dir)
    assert.equal(store.get('broken-json'), null)
    assert.equal(store.loadErrors.length, 1)
    assert.match(store.loadErrors[0]?.message ?? '', /JSON|parse|property name/i)
  })

  it('list 只返回能解析的记录，并按 createdAt 降序', () => {
    const dir = tempDir()
    const store = new SessionRecordStore(dir)
    store.put({ sessionId: 'x1', kind: 'workspace', createdAt: 10 })
    store.put({ sessionId: 'x2', kind: 'ephemeral', createdAt: 20 })
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'junk.json'), 'nope', 'utf8')
    const list = new SessionRecordStore(dir).list()
    assert.deepEqual(list.map((record) => record.sessionId), ['x2', 'x1'])
  })

  it('未知字段不落库（白名单投影）', () => {
    const dir = tempDir()
    const store = new SessionRecordStore(dir)
    store.put({ sessionId: 'w1', kind: 'workspace', createdAt: 1, surprise: 'x' } as never)
    const raw = JSON.parse(readFileSync(join(dir, 'w1.json'), 'utf8')) as Record<string, unknown>
    assert.equal('surprise' in raw, false)
  })
})