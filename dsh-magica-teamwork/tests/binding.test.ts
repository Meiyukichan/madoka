/** 绑定点安全：只允许回环，防止误绑 0.0.0.0 把服务暴露到局域网 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveConfig } from '../src/server/config.js'
import { isLoopbackAddress, isLoopbackHost } from '../src/server/net.js'

// Isolate from the developer's real ~/.dsh/storages/teamwork/config.json.
process.env.DSH_TEAMWORK_DATA = mkdtempSync(join(tmpdir(), 'tw-binding-'))

test('isLoopbackHost：IPv4 回环段 / localhost / ::1 允许', () => {
  for (const h of ['127.0.0.1', '127.0.0.2', '127.1.2.3', 'localhost', 'LOCALHOST', '::1', '[::1]']) {
    assert.equal(isLoopbackHost(h), true, h)
  }
})

test('isLoopbackHost：0.0.0.0 / :: / 局域网 / 域名全部拒绝', () => {
  for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', '172.16.0.1', 'example.com', '', ' ', '127.0.0.256']) {
    assert.equal(isLoopbackHost(h), false, h)
  }
})

test('isLoopbackAddress：双栈映射地址也算回环', () => {
  assert.equal(isLoopbackAddress('127.0.0.1'), true)
  assert.equal(isLoopbackAddress('::1'), true)
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true)
  assert.equal(isLoopbackAddress('127.9.9.9'), true)
  assert.equal(isLoopbackAddress('192.168.1.5'), false)
  assert.equal(isLoopbackAddress('::ffff:192.168.1.5'), false)
})

test('resolveConfig：默认就是 127.0.0.1', () => {
  const { config } = resolveConfig({ argv: [] })
  assert.equal(config.host, '127.0.0.1')
  assert.equal(config.port, 3939)
})

test('resolveConfig：--host 0.0.0.0 直接抛错（不是警告）', () => {
  assert.throws(() => resolveConfig({ argv: ['--host', '0.0.0.0'] }), /只允许回环地址/)
  assert.throws(() => resolveConfig({ argv: ['--host', '192.168.1.5'] }), /只允许回环地址/)
  assert.throws(() => resolveConfig({ argv: ['--host', '::'] }), /只允许回环地址/)
})

test('resolveConfig：环境变量同样受约束', (t) => {
  const prev = process.env.DSH_TEAMWORK_HOST
  t.after(() => {
    if (prev === undefined) delete process.env.DSH_TEAMWORK_HOST
    else process.env.DSH_TEAMWORK_HOST = prev
  })
  process.env.DSH_TEAMWORK_HOST = '0.0.0.0'
  assert.throws(() => resolveConfig({ argv: [] }), /只允许回环地址/)
  process.env.DSH_TEAMWORK_HOST = '127.0.0.1'
  assert.equal(resolveConfig({ argv: [] }).config.host, '127.0.0.1')
})

test('CLI：--host 0.0.0.0 启动失败并给出中文原因', () => {
  const r = spawnSync(process.execPath, ['lib/index.js', '--host', '0.0.0.0', '--port', '0'], {
    encoding: 'utf8',
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`
  assert.notEqual(r.status, 0, '必须以非 0 退出')
  assert.match(output, /只允许回环地址/)
})
