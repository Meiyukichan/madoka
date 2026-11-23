/**
 * 环境与实例发现：baseUrl 六级回退 / config.json 注释容错 / 身份文件缓存 / 实例口径。
 *
 * 对应设计文档 §16.5。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_SERVER_PORT,
  CASTBOARD_DEFAULT_PREFIX,
  castboardInstanceName,
  normalizeBaseUrl,
  resetEnvCache,
  teamworkBaseUrl,
  teamworkDefaultDevice,
  teamworkInstanceName,
} from '../src/sdk/index.js'

const TOUCHED_ENV = [
  'DSH_TEAMWORK_URL',
  'DSH_TEAMWORK_HOST',
  'DSH_TEAMWORK_PORT',
  'DSH_TEAMWORK_DATA',
  'DSH_TEAMWORK_HOME',
  'DSH_TEAMWORK_DEVICE_FILE',
  'DSH_TEAMWORK_INSTANCE',
  'DSH_TEAMWORK_IP',
  'DSH_PORT',
  'PORT',
] as const

function withCleanEnv<T>(fn: () => T): T {
  const saved = new Map<string, string | undefined>()
  for (const key of TOUCHED_ENV) {
    saved.set(key, process.env[key])
    delete process.env[key]
  }
  resetEnvCache()
  try {
    return fn()
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    resetEnvCache()
  }
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-teamwork-sdk-env-'))
}

test('normalizeBaseUrl：裸 origin / 已带前缀 / 尾斜杠 / 默认端口', () => {
  const cases: Array<[string, string]> = [
    ['127.0.0.1', `http://127.0.0.1:${DEFAULT_SERVER_PORT}${CASTBOARD_DEFAULT_PREFIX}`],
    ['127.0.0.1:4000', `http://127.0.0.1:4000${CASTBOARD_DEFAULT_PREFIX}`],
    ['https://team.example.com', `https://team.example.com${CASTBOARD_DEFAULT_PREFIX}`],
    [`http://h:1${CASTBOARD_DEFAULT_PREFIX}/`, `http://h:1${CASTBOARD_DEFAULT_PREFIX}`],
  ]
  for (const [input, expected] of cases) {
    const resolved = normalizeBaseUrl(input)
    assert.equal(resolved.ok, true, `${input} 应能解析`)
    if (resolved.ok) assert.equal(resolved.value, expected)
  }
})

test('normalizeBaseUrl：带业务路径 / 前缀不符 → invalid_host', () => {
  const resolved = normalizeBaseUrl('https://team.example.com/v1/tw')
  assert.equal(resolved.ok, false)
  if (!resolved.ok) assert.match(resolved.reason, /不能带业务路径/)

  const custom = normalizeBaseUrl('https://team.example.com/v1/tw', '/v1/tw')
  assert.equal(custom.ok, true)
  if (custom.ok) assert.equal(custom.value, 'https://team.example.com/v1/tw')
})

test('baseUrl 回退链：显式参数 > 环境变量 > config.json > 默认值', () => {
  withCleanEnv(() => {
    const dir = tempDir()
    try {
      process.env['DSH_TEAMWORK_DATA'] = dir
      writeFileSync(
        join(dir, 'config.json'),
        ['{', '  // 端口由运维改过', '  "host": "127.0.0.1",', '  "port": 4321', '}'].join('\n'),
        'utf8',
      )
      resetEnvCache()

      // ① 只有 config.json
      const fromConfig = teamworkBaseUrl()
      assert.equal(fromConfig.ok, true)
      if (fromConfig.ok) assert.equal(fromConfig.value, `http://127.0.0.1:4321${CASTBOARD_DEFAULT_PREFIX}`)

      // ② 环境变量覆盖 config.json
      process.env['DSH_TEAMWORK_URL'] = 'https://team.example.com'
      const fromEnv = teamworkBaseUrl()
      assert.equal(fromEnv.ok, true)
      if (fromEnv.ok) assert.equal(fromEnv.value, `https://team.example.com${CASTBOARD_DEFAULT_PREFIX}`)

      // ③ host/port 环境变量
      delete process.env['DSH_TEAMWORK_URL']
      process.env['DSH_TEAMWORK_HOST'] = '10.0.0.5'
      process.env['DSH_TEAMWORK_PORT'] = '5000'
      const fromHostEnv = teamworkBaseUrl()
      assert.equal(fromHostEnv.ok, true)
      if (fromHostEnv.ok) assert.equal(fromHostEnv.value, `http://10.0.0.5:5000${CASTBOARD_DEFAULT_PREFIX}`)

      // ④ 显式参数最高
      const explicit = teamworkBaseUrl({ baseUrl: 'http://explicit:9/dsh-teamwork/v1' })
      assert.equal(explicit.ok, true)
      if (explicit.ok) assert.equal(explicit.value, 'http://explicit:9/dsh-teamwork/v1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('config.json 的 domain：本机按 http，线上按 https 且不补端口', () => {
  withCleanEnv(() => {
    const dir = tempDir()
    try {
      process.env['DSH_TEAMWORK_DATA'] = dir
      writeFileSync(join(dir, 'config.json'), JSON.stringify({ domain: '127.0.0.1:4321' }), 'utf8')
      resetEnvCache()
      const local = teamworkBaseUrl()
      assert.equal(local.ok, true)
      if (local.ok) assert.equal(local.value, `http://127.0.0.1:4321${CASTBOARD_DEFAULT_PREFIX}`)

      writeFileSync(join(dir, 'config.json'), JSON.stringify({ domain: 'team.example.com' }), 'utf8')
      resetEnvCache()
      const online = teamworkBaseUrl()
      assert.equal(online.ok, true)
      if (online.ok) assert.equal(online.value, `https://team.example.com${CASTBOARD_DEFAULT_PREFIX}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('config.json 坏了 → 回落默认值，不抛', () => {
  withCleanEnv(() => {
    const dir = tempDir()
    try {
      process.env['DSH_TEAMWORK_DATA'] = dir
      writeFileSync(join(dir, 'config.json'), '{ not json', 'utf8')
      resetEnvCache()
      const resolved = teamworkBaseUrl()
      assert.equal(resolved.ok, true)
      if (resolved.ok) assert.equal(resolved.value, `http://127.0.0.1:${DEFAULT_SERVER_PORT}${CASTBOARD_DEFAULT_PREFIX}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('身份文件：读 host/port → 实例名 ip:port；文件变了会重新解析', () => {
  withCleanEnv(() => {
    const dir = tempDir()
    try {
      const file = join(dir, 'device.json')
      writeFileSync(file, JSON.stringify({ host: '10.1.2.3', port: 3080 }), 'utf8')
      process.env['DSH_TEAMWORK_DEVICE_FILE'] = file
      resetEnvCache()

      assert.equal(teamworkInstanceName(), '10.1.2.3:3080')
      assert.equal(castboardInstanceName(), teamworkInstanceName(), '旧名字别名必须指向同一实现')

      const device = teamworkDefaultDevice()
      assert.equal(device.host, '10.1.2.3')
      assert.equal(device.port, 3080)
      assert.equal(device.os, process.platform)

      // 改内容 → mtime 变 → 重新解析
      writeFileSync(file, JSON.stringify({ host: '10.9.9.9', port: 4000 }), 'utf8')
      assert.equal(teamworkInstanceName(), '10.9.9.9:4000')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('身份文件坏了 → 回落本机网卡（不抛，且 source 不是 identity-file）', () => {
  withCleanEnv(() => {
    const dir = tempDir()
    try {
      const file = join(dir, 'device.json')
      writeFileSync(file, '{ broken', 'utf8')
      process.env['DSH_TEAMWORK_DEVICE_FILE'] = file
      resetEnvCache()
      const instance = teamworkInstanceName()
      assert.ok(instance.length > 0)
      assert.ok(!instance.startsWith('10.1.2.3'))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

test('DSH_TEAMWORK_INSTANCE 显式覆盖一切', () => {
  withCleanEnv(() => {
    const dir = tempDir()
    try {
      const file = join(dir, 'device.json')
      writeFileSync(file, JSON.stringify({ host: '10.1.2.3', port: 3080 }), 'utf8')
      process.env['DSH_TEAMWORK_DEVICE_FILE'] = file
      process.env['DSH_TEAMWORK_INSTANCE'] = 'custom-instance:9999'
      resetEnvCache()
      assert.equal(teamworkInstanceName(), 'custom-instance:9999')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
