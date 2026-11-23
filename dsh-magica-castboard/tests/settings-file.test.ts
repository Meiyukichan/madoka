/**
 * 看板设置文件（`castboard.settings.yaml`）：YAML 子集读写、整对象替换、手改即生效、
 * 坏文件降级、旧台账 settings 迁移，以及只读窗口不落盘。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { SettingsStore, factorySettings, type SettingsStoreOptions } from '../src/host/ledger/settings.ts'
import { parseSettingsYaml, serializeSettingsYaml } from '../src/host/ledger/settings-yaml.ts'
import { ReadOnlyError } from '../src/host/ledger/task-store.ts'
import { castboardPaths } from '../src/host/ledger/paths.ts'
import { tempRoot } from './helpers.ts'

const FILE_NAME = 'castboard.settings.yaml'

function storeAt(root: string, extra: Omit<SettingsStoreOptions, 'file'> = {}): SettingsStore {
  return new SettingsStore({ file: join(root, FILE_NAME), ...extra })
}

test('路径：设置文件与台账同目录，叫 castboard.settings.yaml', () => {
  assert.equal(castboardPaths('C:/root').settingsFile, join('C:/root', FILE_NAME))
})

test('YAML 子集：扁平 key: value 往返，注释/空行/文档标记/null 都可读', () => {
  const text = [
    '\uFEFF---',
    '# 注释行',
    "",
    'maxConcurrent: 4   # 行尾注释',
    'autoRoute: false',
    'portraitRunOnStart: true',
    'commentsEnabled: TRUE',
    'commentPollMs: 2500',
    'defaultPermission: "read-only"',
    "unknownKey: 'x''y'",
    'dropped: null',
    '...',
    '',
  ].join('\r\n')
  assert.deepEqual(parseSettingsYaml(text), {
    maxConcurrent: 4,
    autoRoute: false,
    portraitRunOnStart: true,
    commentsEnabled: true,
    commentPollMs: 2500,
    defaultPermission: 'read-only',
    unknownKey: "x'y",
  })
})

test('YAML 子集：缩进 / 缺值 / 引号未闭合都报可读错误', () => {
  assert.throws(() => parseSettingsYaml('  nested: 1'), /不支持缩进/)
  assert.throws(() => parseSettingsYaml('maxConcurrent:'), /缺少值/)
  assert.throws(() => parseSettingsYaml('defaultPermission: "oops'), /缺少收尾/)
  assert.throws(() => parseSettingsYaml('defaultPermission: "a" b'), /多余内容/)
})

test('写出：只有显式字段，带格式头，且能被自己读回', () => {
  const value = { maxConcurrent: 5, autoRoute: false, portraitRunOnStart: true, defaultPermission: 'read-only' } as const
  const text = serializeSettingsYaml(value)
  assert.match(text, /^# castboard 看板设置/)
  assert.match(text, /^maxConcurrent: 5$/m)
  assert.match(text, /^autoRoute: false$/m)
  assert.match(text, /^portraitRunOnStart: true$/m)
  assert.match(text, /^defaultPermission: read-only$/m)
  assert.equal(/^commentsEnabled:/m.test(text), false, '未设置的字段不落盘')
  assert.deepEqual(parseSettingsYaml(text), { ...value })
})

test('读到缺省：文件不存在时全是出厂默认，且不凭空写文件', async (t) => {
  const root = tempRoot(t)
  const store = storeAt(root)
  assert.deepEqual(await store.read(), factorySettings())
  assert.equal(store.stored().maxConcurrent, undefined)
  assert.deepEqual(existsSync(join(root, FILE_NAME)), false)
})

test('保存：整对象替换，缺的字段回落默认，空对象清空所有键', async (t) => {
  const root = tempRoot(t)
  const store = storeAt(root)
  await store.write({ maxConcurrent: 5, autoRoute: false, commentsEnabled: false })
  assert.equal(store.get().maxConcurrent, 5)
  assert.equal(store.get().autoRoute, false)
  assert.equal(store.get().defaultPermission, factorySettings().defaultPermission, '没写的字段回落默认')

  const text = readFileSync(join(root, FILE_NAME), 'utf8')
  assert.equal(/^defaultPermission:/m.test(text), false, '没写的字段不落盘')

  await store.write({ maxConcurrent: 2 })
  assert.equal(store.stored().autoRoute, undefined, '整体替换，不保留旧字段')

  await store.write({})
  const cleared = readFileSync(join(root, FILE_NAME), 'utf8')
  assert.match(cleared, /^# castboard 看板设置/)
  assert.equal(/^[a-zA-Z]+:/m.test(cleared), false, '只剩格式头')
  assert.deepEqual(await store.read(), factorySettings())
})

test('手改：不用重启，下一次 read 就是新值；未知键忽略', async (t) => {
  const root = tempRoot(t)
  const store = storeAt(root)
  await store.write({ maxConcurrent: 5 })

  writeFileSync(join(root, FILE_NAME), [
    '# 手改',
    'maxConcurrent: 2',
    'autoRoute: false',
    'notAField: whatever',
  ].join('\n'), 'utf8')

  const value = await store.read()
  assert.equal(value.maxConcurrent, 2)
  assert.equal(value.autoRoute, false)
  assert.deepEqual(store.stored(), { maxConcurrent: 2, autoRoute: false })
})

test('坏文件：结构坏或值越界都只降级为默认，文件本身不动', async (t) => {
  const root = tempRoot(t)
  const store = storeAt(root)
  const file = join(root, FILE_NAME)

  writeFileSync(file, '  maxConcurrent: 2\n', 'utf8')
  assert.deepEqual(await store.read(), factorySettings())
  assert.equal(readFileSync(file, 'utf8'), '  maxConcurrent: 2\n', '不覆盖坏文件，留给用户改')

  writeFileSync(file, 'maxConcurrent: 99\n', 'utf8')
  assert.deepEqual(await store.read(), factorySettings())
})

test('旧台账迁移：首次读把 settings 落成 YAML，之后只认 YAML', async (t) => {
  const root = tempRoot(t)
  let legacyValue: { maxConcurrent: number; autoRoute: boolean } | undefined = { maxConcurrent: 4, autoRoute: false }
  const store = storeAt(root, { legacy: async () => legacyValue })

  assert.equal((await store.read()).maxConcurrent, 4)
  assert.equal(existsSync(join(root, FILE_NAME)), true)
  assert.match(readFileSync(join(root, FILE_NAME), 'utf8'), /^maxConcurrent: 4$/m)

  // 迁移之后再改旧值也不影响：文件已经是唯一真值。
  legacyValue = { maxConcurrent: 9, autoRoute: true }
  assert.equal((await store.read()).maxConcurrent, 4)
})

test('旧台账迁移：没有旧值就不写文件；只读窗口只在内存里采用旧值', async (t) => {
  const empty = tempRoot(t)
  const a = storeAt(empty, { legacy: async () => undefined })
  assert.deepEqual(await a.read(), factorySettings())
  assert.equal(existsSync(join(empty, FILE_NAME)), false)

  const readOnlyRoot = tempRoot(t)
  const b = storeAt(readOnlyRoot, { legacy: async () => ({ maxConcurrent: 4 }), canWrite: () => false })
  assert.equal((await b.read()).maxConcurrent, 4)
  assert.equal(existsSync(join(readOnlyRoot, FILE_NAME)), false, '只读窗口不写迁移文件')
})

test('只读窗口：拒绝写设置，抛 ReadOnlyError', async (t) => {
  const root = tempRoot(t)
  const store = storeAt(root, { canWrite: () => false })
  await assert.rejects(() => store.write({ maxConcurrent: 2 }), ReadOnlyError)
  assert.equal(existsSync(join(root, FILE_NAME)), false)
})

test('并发保存：后一次保存不会被前一次的 rename 覆盖（串行化）', async (t) => {
  const root = tempRoot(t)
  const store = storeAt(root)
  await Promise.all([
    store.write({ maxConcurrent: 2 }),
    store.write({ maxConcurrent: 3 }),
    store.write({ maxConcurrent: 4 }),
  ])
  const text = readFileSync(join(root, FILE_NAME), 'utf8')
  assert.match(text, /^maxConcurrent: 4$/m)
  assert.equal((await store.read()).maxConcurrent, 4)
})
