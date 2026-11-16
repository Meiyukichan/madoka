import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createEventLogger, sanitize } from '../../src/core/logger.ts'

const roots: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-log-'))
  roots.push(dir)
  return dir
}

after(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

describe('sanitize', () => {
  it('掩码 sk- / gh* / npm_ / bearer / jwt', () => {
    assert.equal(sanitize('key sk-abcdefgh1234'), 'key sk-***')
    assert.equal(sanitize('ghp_abcdefghijklmnop1234'), 'gh*_***')
    assert.equal(sanitize('npm_abcdefghijklmnop1234'), 'npm_***')
    assert.equal(sanitize('Authorization: Bearer abcdef'), 'Authorization: Bearer ***')
    assert.equal(sanitize('eyJhbGciOi.eyJzdWIiOi.sigPart99'), 'jwt.***')
  })

  it('掩码 password/token 键值并剥控制字符', () => {
    assert.equal(sanitize('password=hunter2'), 'password=***')
    assert.equal(sanitize('line\u0000break\u001f'), 'linebreak')
  })

  it('掩码手机号与身份证', () => {
    assert.equal(sanitize('call 13800138000 now'), 'call 1********** now')
    assert.equal(sanitize('id 110101199003077777'), 'id ******************')
  })

  it('18 位证件号整条掩码（数字边界断言保证不会被手机号规则截断）', () => {
    const masked = sanitize('id 130101199003071234 end')
    assert.equal(masked, 'id ****************** end')
    assert.ok(!masked.includes('1234'), `尾部不得残留：${masked}`)
    assert.ok(!masked.includes('1990'), `出生年不得残留：${masked}`)
  })

  it('保留普通文本', () => {
    assert.equal(sanitize('hello world'), 'hello world')
  })
})

describe('createEventLogger', () => {
  it('目录名必须单段：带分隔符直接抛（真机 bug：曾拼出 logs/pkg/questions/）', () => {
    assert.throws(() => createEventLogger('dsh-magica-spellbook/questions'), /one path segment/)
    assert.throws(() => createEventLogger(''), /one path segment/)
    assert.throws(() => createEventLogger('..'), /one path segment/)
  })
  it('写内存 + 落盘，文件名用本周一', async () => {
    const dir = tempDir()
    const logger = createEventLogger('demo', dir)
    logger.logEvent('info', 'boot', 'started')
    await logger.flush()
    const files = readdirSync(dir).filter((name) => name.startsWith('log-'))
    assert.equal(files.length, 1)
    const name = files[0] ?? ''
    assert.match(name, /^log-\d{4}-\d{2}-\d{2}\.ndjson$/)
    const text = readFileSync(join(dir, name), 'utf8')
    assert.match(text, /"event":"boot"/)
    logger.dispose()
  })

  it('dispose 之后不再写盘（C-035 回归）', async () => {
    const dir = tempDir()
    const logger = createEventLogger('demo', dir)
    logger.logEvent('info', 'before', 'x')
    await logger.flush()
    logger.dispose()
    // dispose 后继续写事件：既不该进内存缓冲，也不该落盘
    for (let i = 0; i < 60; i += 1) logger.logEvent('info', 'after', String(i))
    await new Promise((resolve) => setTimeout(resolve, 30))
    const files = readdirSync(dir).filter((name) => name.startsWith('log-'))
    const text = readFileSync(join(dir, files[0] ?? ''), 'utf8')
    assert.match(text, /"event":"before"/)
    assert.doesNotMatch(text, /"event":"after"/, 'dispose 后必须停止持久化')
  })

  it('readPersistentLog 合并尚未 flush 的待写行', () => {
    const dir = tempDir()
    const logger = createEventLogger('demo', dir)
    logger.logEvent('warn', 'pending', 'not-flushed-yet')
    const lines = logger.readPersistentLog(10)
    assert.equal(lines.length, 1)
    assert.match(lines[0] ?? '', /not-flushed-yet/)
    logger.dispose()
  })

  it('超过 200 条丢最旧', () => {
    const dir = tempDir()
    const logger = createEventLogger('demo', dir)
    for (let index = 0; index < 250; index += 1) logger.logEvent('info', 'n', `item-${index}`)
    const report = logger.exportLogs({ plugin: 'demo' })
    assert.match(report, /item-249/)
    assert.doesNotMatch(report, /item-0:/)
    logger.dispose()
  })

  it('exportLogs 段落标题与空缓冲占位串逐字', () => {
    const dir = tempDir()
    const logger = createEventLogger('demo', dir)
    const report = logger.exportLogs({ plugin: 'demo', version: '1' })
    assert.match(report, /^# demo log export/)
    assert.match(report, /plugin: demo/)
    assert.match(report, /## profile state/)
    assert.match(report, /## previous sessions \(persisted log\)/)
    assert.match(report, /## events this session/)
    assert.match(report, /\(none - the buffer starts empty on every start\)/)
    logger.dispose()
  })

  it('dispose 幂等，且之后仍可写内存', () => {
    const dir = tempDir()
    const logger = createEventLogger('demo', dir)
    logger.dispose()
    logger.dispose()
    logger.logEvent('info', 'after-dispose', 'still buffered')
    assert.match(logger.exportLogs({}), /still buffered/)
  })
})
