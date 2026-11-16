import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { ensureWorkspaceForSession } from '../../src/sessions/workspace.ts'
import {
  ensureWorkspace,
  findWorkspace,
  getWorkspaceRegistry,
  normalizeProjectPath,
} from '../../src/sessions/ensure-workspace.ts'
import { fakeCtx } from '../helpers/fake.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-ws-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

/** 造一个内存版 workspaceRegistry（形状与 dsh 0.2 一致）。 */
function fakeRegistry(seed: Array<{ id: string; path: string }> = []) {
  const byId = new Map(seed.map((item) => [item.id, { ...item, attached: [] as string[] }]))
  let next = seed.length + 1
  return {
    created: [] as string[],
    attached: [] as string[],
    async create(path: string) {
      const record = { id: `ws-${next++}`, path, attached: [] as string[] }
      byId.set(record.id, record)
      this.created.push(path)
      return {
        id: record.id,
        path: record.path,
        async attachSession(sessionId: string) {
          record.attached.push(sessionId)
        },
      }
    },
    async resolveByPath(path: string) {
      const found = [...byId.values()].find((item) => item.path === path)
      if (found === undefined) return undefined
      return {
        id: found.id,
        path: found.path,
        async attachSession(sessionId: string) {
          found.attached.push(sessionId)
        },
      }
    },
    get(id: string) {
      const found = byId.get(id)
      return found === undefined ? undefined : { id: found.id, path: found.path }
    },
    list() {
      return [...byId.values()].map((item) => ({ id: item.id, path: item.path }))
    },
    byId,
  }
}

describe('normalizeProjectPath', () => {
  it('归一分隔符并剥尾部斜杠，保留盘符根', () => {
    assert.equal(normalizeProjectPath('D:/a/b/'), normalizeProjectPath('D:\\a\\b'))
    assert.match(normalizeProjectPath('D:\\'), /^D:[\\/]$/)
    assert.equal(normalizeProjectPath(''), '')
  })
})

describe('getWorkspaceRegistry', () => {
  it('缺失 / 形状不符返回 undefined（绝不抛）', () => {
    assert.equal(getWorkspaceRegistry(fakeCtx()), undefined)
    // 实现刻意不做形状校验：拿到什么返回什么（调用方自己判方法存在）
    assert.deepEqual(getWorkspaceRegistry(fakeCtx({ workspaceRegistry: {} })), {})
    const registry = fakeRegistry()
    assert.equal(getWorkspaceRegistry(fakeCtx({ workspaceRegistry: registry })), registry)
  })
})

describe('findWorkspace / ensureWorkspace', () => {
  it('findWorkspace 只查不建', async () => {
    const registry = fakeRegistry([{ id: 'ws-1', path: normalizeProjectPath('D:/proj') }])
    const ctx = fakeCtx({ workspaceRegistry: registry })
    const found = await findWorkspace(ctx, normalizeProjectPath('D:/proj'))
    assert.equal(found?.id, 'ws-1')
    assert.equal(await findWorkspace(ctx, 'D:/nope'), undefined)
    assert.equal(registry.created.length, 0)
  })

  it('ensureWorkspace 命中已存在的不重复创建', async () => {
    const registry = fakeRegistry([{ id: 'ws-1', path: normalizeProjectPath('D:/proj') }])
    const ctx = fakeCtx({ workspaceRegistry: registry })
    const workspace = await ensureWorkspace(ctx, normalizeProjectPath('D:/proj'))
    assert.equal(workspace?.id, 'ws-1')
    assert.deepEqual(registry.created, [])
  })

  it('ensureWorkspace 未命中则创建，并在给了 attachSessionId 时挂载成员', async () => {
    const registry = fakeRegistry()
    const ctx = fakeCtx({ workspaceRegistry: registry })
    const workspace = await ensureWorkspace(ctx, 'D:/fresh', { title: 'T', attachSessionId: 's-9' })
    assert.equal(workspace?.id, 'ws-1')
    assert.deepEqual(registry.created, [normalizeProjectPath('D:/fresh')])
    assert.deepEqual(registry.byId.get('ws-1')?.attached, ['s-9'])
  })

  it('registry 不可用 → undefined（不抛）', async () => {
    assert.equal(await ensureWorkspace(fakeCtx(), 'D:/x'), undefined)
    assert.equal(await ensureWorkspaceForSession(fakeCtx(), 'D:/x'), undefined)
  })

  it('ensureWorkspaceForSession 只回 id', async () => {
    const registry = fakeRegistry()
    const ctx = fakeCtx({ workspaceRegistry: registry })
    assert.equal(await ensureWorkspaceForSession(ctx, 'D:/p2'), 'ws-1')
  })

  it('create 抛错时**向上抛**（fail-loud：不能假装挂上了 workspace）', async () => {
    const broken = {
      ...fakeRegistry(),
      async create() {
        throw new Error('registry exploded')
      },
      async resolveByPath() {
        return undefined
      },
    }
    await assert.rejects(
      () => ensureWorkspace(fakeCtx({ workspaceRegistry: broken }), 'D:/z'),
      /registry exploded/,
    )
  })

  it('projectPath 为空 → 立刻抛（不静默建根目录 workspace）', async () => {
    await assert.rejects(() => ensureWorkspace(fakeCtx({ workspaceRegistry: fakeRegistry() }), ''), /must not be empty/)
    await assert.rejects(() => findWorkspace(fakeCtx({ workspaceRegistry: fakeRegistry() }), ''), /must not be empty/)
  })
})
