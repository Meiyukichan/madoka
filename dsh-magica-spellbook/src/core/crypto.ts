/**
 * 单字段加解密：Windows DPAPI（可用时）/ 其它平台 AES-256-GCM。
 *
 * 两条硬规则（见 `docs/design/01-core-utils.zh.md` §2.3）：
 * - **解密绝不创建密钥**（否则会把"旧密钥丢失"伪装成"解不开"，还会往磁盘写垃圾）；
 * - **创建密钥用排他 flag**（并发首建时用 EEXIST 重读赢家密钥，避免双方各写一把）。
 *
 * @module dsh-magica-spellbook/core/crypto
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { dshHomePath } from './home.ts'

/** 构造选项。 */
export interface FieldCryptoOptions {
  /** 主密钥文件；默认 `~/.dsh/storages/codeagent/master.key`。 */
  masterKeyPath?: string
  /** 主密钥所在目录；默认 `dirname(masterKeyPath)`。 */
  storageDir?: string
  /**
   * 加密失败时是否抛错。默认 `false`（历史契约：返回明文）。
   * spellbook 自己的调用点必须传 `true`。
   */
  strictEncrypt?: boolean
}

/** 加解密句柄。 */
export interface FieldCryptoHandle {
  encryptField(plain: string): string
  decryptField(ciphertext: string): string
  readMasterKey(): Buffer
}

const KEY_BYTES = 32
const IV_BYTES = 12
const ALGORITHM = 'aes-256-gcm'

interface DpapiModule {
  protectData(data: Buffer, scope: string): Buffer | string
  unprotectData(data: Buffer | string): Buffer | string
}

function defaultKeyPath(): string {
  return dshHomePath('storages', 'codeagent', 'master.key')
}

function toBuffer(value: Buffer | string): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'base64') : value
}

function loadDpapi(): DpapiModule | null {
  if (process.platform !== 'win32') return null
  const require = createRequire(import.meta.url)
  try {
    return require('@primno/dpapi') as DpapiModule
  } catch {
    // 第二级：dsh profile 里可能装了它（部署约定路径）
    try {
      const anchor = dshHomePath('profiles', 'web', 'node_modules', '@primno', 'dpapi', 'package.json')
      return createRequire(anchor)('@primno/dpapi') as DpapiModule
    } catch {
      return null
    }
  }
}

/**
 * 创建加解密句柄。
 * @param options - 路径与严格模式。
 */
export async function createFieldCrypto(options: FieldCryptoOptions = {}): Promise<FieldCryptoHandle> {
  const masterKeyPath = options.masterKeyPath ?? defaultKeyPath()
  const storageDir = options.storageDir ?? dirname(masterKeyPath)
  const strictEncrypt = options.strictEncrypt ?? false
  const dpapi = loadDpapi()
  let cachedKey: Buffer | null = null

  function tryReadMasterKey(): Buffer | null {
    if (cachedKey !== null) return cachedKey
    try {
      const raw = readFileSync(masterKeyPath)
      if (raw.length < KEY_BYTES) return null
      cachedKey = raw.subarray(0, KEY_BYTES)
      return cachedKey
    } catch {
      return null
    }
  }

  function readMasterKey(): Buffer {
    const existing = tryReadMasterKey()
    if (existing !== null) return existing
    mkdirSync(storageDir, { recursive: true })
    const fresh = randomBytes(KEY_BYTES)
    try {
      writeFileSync(masterKeyPath, fresh, { mode: 0o600, flag: 'wx' })
      cachedKey = fresh
      return fresh
    } catch {
      // 并发首建：对方赢了，必须用**对方**的密钥加密
      const winner = tryReadMasterKey()
      if (winner === null) {
        throw new Error(`field-crypto: cannot create or read master key at ${masterKeyPath}`)
      }
      return winner
    }
  }

  function encryptWithAes(plain: string): string {
    const key = readMasterKey()
    const iv = randomBytes(IV_BYTES)
    const cipher = createCipheriv(ALGORITHM, key, iv)
    const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${iv.toString('hex')}:${tag.toString('hex')}:${body.toString('hex')}`
  }

  function encryptField(plain: string): string {
    if (plain === '') return plain
    if (dpapi !== null) {
      try {
        return toBuffer(dpapi.protectData(Buffer.from(plain, 'utf8'), 'CurrentUser')).toString('base64')
      } catch {
        // DPAPI 不可用（非交互会话等）：降级 AES，绝不回退明文
      }
    }
    try {
      return encryptWithAes(plain)
    } catch (error) {
      if (strictEncrypt) throw error
      return plain
    }
  }

  function decryptField(ciphertext: string): string {
    if (ciphertext === '') return ciphertext
    if (dpapi !== null) {
      try {
        return toBuffer(dpapi.unprotectData(Buffer.from(ciphertext, 'base64'))).toString('utf8')
      } catch {
        // 不是 DPAPI 密文（或跨机器）：继续试 AES
      }
    }
    const key = tryReadMasterKey()
    if (key === null) return ciphertext
    const parts = ciphertext.split(':')
    if (parts.length !== 3) return ciphertext
    const [ivHex, tagHex, bodyHex] = parts
    if (ivHex === undefined || tagHex === undefined || bodyHex === undefined) return ciphertext
    try {
      const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
      decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
      return Buffer.concat([
        decipher.update(Buffer.from(bodyHex, 'hex')),
        decipher.final(),
      ]).toString('utf8')
    } catch {
      // GCM 认证失败 / 密钥不匹配：原样返回，调用方用 `=== ciphertext` 判定"没解开"
      return ciphertext
    }
  }

  return { encryptField, decryptField, readMasterKey }
}

/** master.key 是否已存在（诊断用）。 */
export function masterKeyExists(masterKeyPath?: string): boolean {
  try {
    return statSync(masterKeyPath ?? defaultKeyPath()).size >= KEY_BYTES
  } catch {
    return false
  }
}
