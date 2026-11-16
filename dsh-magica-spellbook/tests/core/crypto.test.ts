import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, describe, it } from 'node:test'
import { createFieldCrypto, masterKeyExists } from '../../src/core/crypto.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'spellbook-crypto-'))
  dirs.push(dir)
  return dir
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

describe('createFieldCrypto', () => {
  it('AES 往返（空串原样）', async () => {
    const dir = tempDir()
    const crypto = await createFieldCrypto({ masterKeyPath: join(dir, 'master.key'), strictEncrypt: true })
    assert.equal(crypto.encryptField(''), '')
    assert.equal(crypto.decryptField(''), '')
    const cipher = crypto.encryptField('hello 世界')
    assert.notEqual(cipher, 'hello 世界')
    assert.equal(crypto.decryptField(cipher), 'hello 世界')
  })

  it('同一个 key 两次加密产生不同密文（随机 IV）', async () => {
    const dir = tempDir()
    const crypto = await createFieldCrypto({ masterKeyPath: join(dir, 'master.key'), strictEncrypt: true })
    const first = crypto.encryptField('same')
    const second = crypto.encryptField('same')
    assert.notEqual(first, second)
    assert.equal(crypto.decryptField(first), 'same')
    assert.equal(crypto.decryptField(second), 'same')
  })

  it('解不开时原样返回（调用方用 === 判定）', async () => {
    const dir = tempDir()
    const crypto = await createFieldCrypto({ masterKeyPath: join(dir, 'master.key'), strictEncrypt: true })
    assert.equal(crypto.decryptField('not-a-ciphertext'), 'not-a-ciphertext')
    assert.equal(crypto.decryptField('aa:bb:cc'), 'aa:bb:cc')
  })

  it('master.key 是被解密的密钥且只创建一次（0600）', async () => {
    const dir = tempDir()
    const keyPath = join(dir, 'master.key')
    assert.equal(masterKeyExists(keyPath), false)
    const first = await createFieldCrypto({ masterKeyPath: keyPath, strictEncrypt: true })
    const keyA = first.readMasterKey()
    assert.equal(masterKeyExists(keyPath), true)
    const second = await createFieldCrypto({ masterKeyPath: keyPath, strictEncrypt: true })
    assert.deepEqual(second.readMasterKey(), keyA)
    if (process.platform !== 'win32') {
      const mode = statSync(keyPath).mode & 0o777
      assert.equal(mode, 0o600)
    }
  })

  it('解密路径不会创建 key', async () => {
    const dir = tempDir()
    const keyPath = join(dir, 'missing.key')
    const crypto = await createFieldCrypto({ masterKeyPath: keyPath, strictEncrypt: true })
    assert.equal(crypto.decryptField('aa:bb:cc'), 'aa:bb:cc')
    assert.equal(masterKeyExists(keyPath), false)
  })

  it('并发首建最终只有一把可用的 key', async () => {
    const dir = tempDir()
    const keyPath = join(dir, 'master.key')
    const [a, b] = await Promise.all([
      createFieldCrypto({ masterKeyPath: keyPath, strictEncrypt: true }),
      createFieldCrypto({ masterKeyPath: keyPath, strictEncrypt: true }),
    ])
    const keyA = a.readMasterKey()
    const keyB = b.readMasterKey()
    assert.deepEqual(keyA, keyB)
  })
})
