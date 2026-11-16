/**
 * 本地凭据存储：AES-256-GCM 信封 + 独立密钥文件。
 *
 * 明文里只存 `accountToken`（= SHA256(账号:密码)，JWT 签名密钥）+ 账号信息 + `ttlSeconds`；
 * **不存 `authToken`**（每个请求现签）。
 *
 * 目录：`$DSH_TEAMWORK_HOME`（默认 `~/.dsh/storages/teamwork`）
 *   .credentials.key   32 字节原始密钥的 base64url（0600）
 *   .credentials.json  AES-256-GCM 信封
 */
import { chmodSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { GlobalRole } from './legacy/types.js'

export interface StoredCredential {
  v: 1
  server: string
  accountId: string
  displayName: string | null
  globalRole: GlobalRole
  accountToken: string
  ttlSeconds: number
  savedAt: string
}

interface Envelope {
  v: 1
  alg: 'aes-256-gcm'
  kid: string
  iv: string
  tag: string
  ct: string
}

export class CredentialError extends Error {
  readonly code: string
  constructor(code: string, message: string) {
    super(message)
    this.name = 'CredentialError'
    this.code = code
  }
}

export function defaultHome(): string {
  return process.env.DSH_TEAMWORK_HOME ?? join(homedir(), '.dsh', 'storages', 'teamwork')
}

export class CredentialStore {
  private readonly keyPath: string
  private readonly filePath: string
  private readonly lockPath: string

  constructor(private readonly home: string = defaultHome()) {
    this.keyPath = join(home, '.credentials.key')
    this.filePath = join(home, '.credentials.json')
    this.lockPath = join(home, '.credentials.lock')
  }

  get paths(): { key: string; file: string } {
    return { key: this.keyPath, file: this.filePath }
  }

  /** 读凭据；文件不存在返回 null（不是错误） */
  load(): StoredCredential | null {
    if (!existsSync(this.filePath)) return null
    const key = this.readKey()
    let envelope: Envelope
    try {
      envelope = JSON.parse(readFileSync(this.filePath, 'utf8')) as Envelope
    } catch (err) {
      throw new CredentialError('credential_corrupt', `凭据文件不是合法 JSON：${(err as Error).message}`)
    }
    try {
      const iv = Buffer.from(envelope.iv, 'base64url')
      const tag = Buffer.from(envelope.tag, 'base64url')
      const ct = Buffer.from(envelope.ct, 'base64url')
      const decipher = createDecipheriv('aes-256-gcm', key, iv)
      decipher.setAAD(Buffer.from(`dsh-teamwork/credential/v1|${envelope.kid}`, 'utf8'))
      decipher.setAuthTag(tag)
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
      return JSON.parse(plain) as StoredCredential
    } catch {
      throw new CredentialError('credential_corrupt', '凭据解密失败（密钥变了或文件被篡改）')
    }
  }

  /** 原子写入（tmp + rename），并用 0600 创建文件 */
  save(credential: StoredCredential): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const key = this.ensureKey()
    const kid = fingerprint(key)
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`dsh-teamwork/credential/v1|${kid}`, 'utf8'))
    const ct = Buffer.concat([cipher.update(JSON.stringify(credential), 'utf8'), cipher.final()])
    const envelope: Envelope = {
      v: 1,
      alg: 'aes-256-gcm',
      kid,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ct: ct.toString('base64url'),
    }

    const release = this.acquireLock()
    try {
      const tmp = `${this.filePath}.tmp`
      writeFileSync(tmp, JSON.stringify(envelope, null, 2), { mode: 0o600 })
      renameSync(tmp, this.filePath)
      try {
        chmodSync(this.filePath, 0o600)
      } catch {
        /* Windows 上 chmod 无效，依赖用户目录 ACL */
      }
    } finally {
      release()
    }
  }

  /** 退出 / 重置：删除凭据文件，保留密钥（换人用时调 reset 连密钥一起删） */
  clear(alsoKey = false): void {
    if (existsSync(this.filePath)) unlinkSync(this.filePath)
    if (alsoKey && existsSync(this.keyPath)) unlinkSync(this.keyPath)
  }

  private ensureKey(): Buffer {
    if (existsSync(this.keyPath)) return this.readKey()
    const key = randomBytes(32)
    writeFileSync(this.keyPath, key.toString('base64url'), { mode: 0o600 })
    try {
      chmodSync(this.keyPath, 0o600)
    } catch {
      /* ignore */
    }
    return key
  }

  private readKey(): Buffer {
    try {
      const key = Buffer.from(readFileSync(this.keyPath, 'utf8').trim(), 'base64url')
      if (key.length !== 32) throw new Error('长度不是 32 字节')
      return key
    } catch (err) {
      throw new CredentialError('credential_key_invalid', `密钥文件不可用：${(err as Error).message}`)
    }
  }

  private acquireLock(): () => void {
    for (let i = 0; i < 10; i++) {
      try {
        const fd = openSync(this.lockPath, 'wx')
        closeSync(fd)
        return () => {
          try {
            unlinkSync(this.lockPath)
          } catch {
            /* ignore */
          }
        }
      } catch {
        const until = Date.now() + 100
        while (Date.now() < until) {
          /* 100ms 退避 */
        }
      }
    }
    throw new CredentialError('credential_busy', '凭据文件被其他进程占用')
  }
}

function fingerprint(key: Buffer): string {
  return key.subarray(0, 4).toString('hex')
}
