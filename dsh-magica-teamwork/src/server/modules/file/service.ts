/**
 * 文件（F1–F3）：本体在 `dataDir/files/<fileId>`，**不建元数据表**。
 *
 * 因此：
 *  - 无法判断"谁上传的" → F3 只允许 administrator
 *  - 无法还原原文件名 → 下载时 `Content-Disposition` 给 `fileId`
 *  - 不校验 fileId 是否存在（只校验 UUID v4 格式）
 */
import type { DatabaseSync } from 'node:sqlite'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Readable } from 'node:stream'
import { errors, nowIso } from '../../errors.js'
import { row } from '../../db/rows.js'
import type { CurrentUser } from '../../auth/guard.js'

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export interface FileVo {
  fileId: string
  fileName: string
  size: number
  sha256: string
  createdAt: string
}

export interface FileServiceDeps {
  db: DatabaseSync
  dataDir: string
  maxUploadBytes: number
}

export class FileService {
  private readonly filesDir: string

  constructor(private readonly deps: FileServiceDeps) {
    this.filesDir = join(deps.dataDir, 'files')
    mkdirSync(this.filesDir, { recursive: true })
  }

  /** 只做格式校验，不碰磁盘（防路径穿越） */
  static isFileId(value: string): boolean {
    return UUID_V4_RE.test(value)
  }

  private pathOf(fileId: string): string {
    if (!FileService.isFileId(fileId)) throw errors.invalidFileId()
    return join(this.filesDir, fileId)
  }

  /**
   * F1 上传：流式落盘 + 边写边算 sha256。
   * 顺序：写 `.tmp` → 校验哈希 → rename 成正式名；任何失败都清掉半成品。
   */
  async upload(stream: Readable, headers: { fileName?: string; sha256?: string }): Promise<FileVo> {
    const fileName = decodeFileName(headers.fileName)
    const expected = headers.sha256 ? headers.sha256.toLowerCase() : null
    if (expected && !/^[0-9a-f]{64}$/.test(expected)) throw errors.invalidRequest('X-File-Sha256 必须是 64 位小写 hex')

    const fileId = randomUUID()
    const tmp = join(this.filesDir, `${fileId}.tmp`)
    const final = join(this.filesDir, fileId)
    const hash = createHash('sha256')
    let size = 0

    try {
      // 手动泵，既算哈希又能在超限时立刻中断（不把整个 body 读进内存）
      const maxBytes = this.deps.maxUploadBytes
      await pipeline(
        stream,
        async function* (source: AsyncIterable<Buffer | string>) {
          for await (const raw of source) {
            const chunk = typeof raw === 'string' ? Buffer.from(raw) : raw
            size += chunk.length
            if (size > maxBytes) throw errors.invalidRequest(`文件超过上限 ${maxBytes} 字节`)
            hash.update(chunk)
            yield chunk
          }
        },
        createWriteStream(tmp),
      )

      const sha256 = hash.digest('hex')
      if (expected && sha256 !== expected) {
        unlinkSync(tmp)
        throw errors.sha256Mismatch()
      }
      renameSync(tmp, final)
      return { fileId, fileName, size, sha256, createdAt: nowIso() }
    } catch (err) {
      try {
        if (existsSync(tmp)) unlinkSync(tmp)
      } catch {
        /* 清理失败不掩盖原始错误 */
      }
      throw err
    }
  }

  /** F2 下载：只要登录即可（不做资源级鉴权） */
  openDownload(fileId: string): { stream: ReturnType<typeof createReadStream>; size: number } {
    const path = this.pathOf(fileId)
    if (!existsSync(path)) throw errors.fileNotFoundByFileId(fileId)
    const st = statSync(path)
    return { stream: createReadStream(path), size: st.size }
  }

  /** F3 删除（仅 administrator）：先清附件引用，再删文件 */
  remove(user: CurrentUser, fileId: string): void {
    if (user.globalRole !== 'administrator') throw errors.forbidden('删除文件需要 administrator')
    if (!FileService.isFileId(fileId)) throw errors.invalidFileId()
    this.deps.db.exec('BEGIN IMMEDIATE')
    try {
      this.deps.db.prepare('DELETE FROM dsh_teamwork_issue_attachment WHERE file_id = ?').run(fileId)
      this.deps.db.exec('COMMIT')
    } catch (err) {
      this.deps.db.exec('ROLLBACK')
      throw err
    }
    const path = join(this.filesDir, fileId)
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      /* 幂等：文件不在也算成功 */
    }
  }

  /** 附件查询共用：判断某 fileId 是否挂在某个 issue 上（当前 F2 不需要，保留给将来收紧权限） */
  isAttached(fileId: string): boolean {
    return row<{ ok: number }>(this.deps.db.prepare('SELECT 1 AS ok FROM dsh_teamwork_issue_attachment WHERE file_id = ? LIMIT 1').get(fileId)) !== undefined
  }
}

/** `X-File-Name` 是 percent-encoded UTF-8；去掉路径分隔符，长度 ≤255 */
function decodeFileName(raw: string | undefined): string {
  if (!raw) throw errors.invalidFileName('缺少 X-File-Name')
  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    throw errors.invalidFileName('不是合法的 percent-encoding')
  }
  const base = decoded.split(/[\\/]/).pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f]/g, '').trim()
  if (!cleaned) throw errors.invalidFileName('为空')
  if (cleaned.length > 255) throw errors.invalidFileName('超过 255 个字符')
  return cleaned
}
