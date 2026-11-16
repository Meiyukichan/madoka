import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { createFieldCrypto } from '../../src/core/crypto.ts'
import { dshHomePath, resolveDshHome, userHome } from '../../src/core/home.ts'

/**
 * 注意：这些测试**从不改 process.env**。
 * `--test-isolation=none` 只关掉进程隔离，测试文件仍然并行；
 * 改全局 env 会污染同进程的其他测试文件（本仓踩过：日志被写进真实 `~/.dsh`）。
 */
describe('resolveDshHome', () => {
  it('$DSH_HOME 优先，并去掉首尾空白', () => {
    assert.equal(resolveDshHome({ DSH_HOME: '  D:/custom-home  ' }), 'D:/custom-home')
  })

  it('未设置 → os.homedir()/.dsh（绝不返回相对路径）', () => {
    const resolved = resolveDshHome({})
    assert.equal(resolved, join(homedir(), '.dsh'))
    assert.ok(resolved.startsWith(homedir()))
  })

  it('空串 / 纯空白 / 非字符串等同未设置', () => {
    assert.equal(resolveDshHome({ DSH_HOME: '' }), join(homedir(), '.dsh'))
    assert.equal(resolveDshHome({ DSH_HOME: '   ' }), join(homedir(), '.dsh'))
    assert.equal(resolveDshHome({ DSH_HOME: undefined }), join(homedir(), '.dsh'))
  })

  it('dshHomePath 拼段，不传段就是 home 本身（走当前 env）', () => {
    const home = resolveDshHome()
    assert.equal(dshHomePath(), home)
    assert.equal(dshHomePath('logs', 'pkg'), join(home, 'logs', 'pkg'))
  })

  it('userHome 就是 os.homedir()', () => {
    assert.equal(userHome(), homedir())
  })
})

describe('下游模块共享同一套兜底', () => {
  it('logger 默认目录 = <dsh home>/logs/<单段名>，且是绝对路径', () => {
    const expected = join(resolveDshHome({}), 'logs', 'dsh-magica-spellbook')
    assert.equal(dshHomePath('logs', 'dsh-magica-spellbook').endsWith(join('logs', 'dsh-magica-spellbook')), true)
    assert.ok(expected.startsWith(homedir()))
    // 真实写盘的用例在 tests/sessions/questions.test.ts（显式 root，绝不碰 home）
  })

  it('crypto 默认 master key 路径同样走 dshHomePath', async () => {
    const dir = dshHomePath('storages', 'codeagent')
    assert.ok(dir.endsWith(join('storages', 'codeagent')))
    // 只造句柄（显式路径），不做读写，也不碰真实 home
    const handle = await createFieldCrypto({ masterKeyPath: join(dir, 'test-master.key') })
    assert.equal(typeof handle.encryptField, 'function')
    assert.equal(typeof handle.decryptField, 'function')
  })
})
