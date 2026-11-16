/**
 * 文件分组（F1–F3）：raw body 上传、带鉴权下载、删除。
 *
 * 与旧 lattice 的差异（协议如此）：
 *  - 上传是 **raw `application/octet-stream` + `X-File-Name`（percent-encoded）**，
 *    不再手拼 multipart；`contentType` 只用于本地推断，协议只认 octet-stream；
 *  - 服务端**不落文件元数据表**，所以 `fileName`/`size`/`sha256` 只在**上传响应**里回；
 *  - 下载只需签名头（不做资源级鉴权）；`downloadPublic()` 是 `download()` 的别名（协议无匿名口，D14）。
 */

import type { LatticeTransport } from './transport.js'
import { latticeFail, latticeOk, type LatticeResult } from './result.js'
import type { LatticeFileInfo } from './types.js'
import { LATTICE_FILE_TIMEOUT_MS } from './transport.js'

/** fileId 形状（服务端 F2/F3 都校验 UUID v4） */
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface LatticeFileUploadInput {
  /** 文件名（协议要求 ≤255，UTF-8 编码后 percent-encoded 进头） */
  name: string
  data: string | Uint8Array
  /** 仅本地提示用；协议只接受 `application/octet-stream` */
  contentType?: string
  /** 可选：64 位小写 hex；给了服务端会边写边算并比对（不符 → 400 sha256_mismatch） */
  sha256?: string
}

export class LatticeFileApi {
  constructor(private readonly transport: LatticeTransport) {}

  /** F1 `POST /files`：上传（返回 `fileId` 等元信息；服务端不回原名之前的记录可查） */
  async upload(input: LatticeFileUploadInput): Promise<LatticeResult<LatticeFileInfo>> {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (name === '') {
      return latticeFail({ status: 400, code: 'invalid_file_name', reason: 'fileName 必填', field: 'fileName' })
    }
    if (input.contentType !== undefined && !input.contentType.startsWith('application/octet-stream')) {
      // 不拦（协议只认 octet-stream，这里忽略调用方的 contentType），但要让人知道
      // 具体行为见文件头注释
    }
    const bytes = typeof input.data === 'string' ? new TextEncoder().encode(input.data) : input.data
    if (bytes.byteLength === 0) {
      return latticeFail({
        status: 400,
        code: 'invalid_file_name',
        reason: '文件是 0 字节：服务端会拒收',
        field: 'data',
      })
    }
    const result = await this.transport.callRaw('fileUpload', {}, {
      body: bytes,
      headers: {
        'content-type': 'application/octet-stream',
        'x-file-name': encodeURIComponent(name),
        ...(input.sha256 === undefined ? {} : { 'x-file-sha256': input.sha256 }),
      },
      timeoutMs: Math.max(this.transport.timeoutMs, LATTICE_FILE_TIMEOUT_MS),
    })
    if (!result.ok) return result
    try {
      const info = (await result.data.json()) as LatticeFileInfo
      return latticeOk(result.status, info)
    } catch (err) {
      return latticeFail({
        status: result.status,
        code: 'network_error',
        reason: `上传响应不是合法 JSON：${(err as Error).message}`,
      })
    }
  }

  /** F2 `GET /files/{fileId}`：带鉴权下载（返回 Buffer；大文件不设总超时） */
  async download(fileId: string): Promise<LatticeResult<Buffer>> {
    const checked = this.checkFileId(fileId)
    if (checked !== null) return checked
    const result = await this.transport.callRaw('fileDownload', { fileId }, { noTimeout: true })
    if (!result.ok) return result
    try {
      const buffer = Buffer.from(await result.data.arrayBuffer())
      return latticeOk(result.status, buffer)
    } catch (err) {
      return latticeFail({
        status: result.status,
        code: 'network_error',
        reason: `下载响应读取失败：${(err as Error).message}`,
      })
    }
  }

  /** F2 的别名：**协议没有匿名下载口**（D14），行为与 `download()` 完全一致 */
  async downloadPublic(fileId: string): Promise<LatticeResult<Buffer>> {
    return this.download(fileId)
  }

  /** F3 `DELETE /files/{fileId}`：删除（administrator；会先清附件引用，幂等） */
  async remove(fileId: string): Promise<LatticeResult<void>> {
    const checked = this.checkFileId(fileId)
    if (checked !== null) return checked
    return this.transport.call<void>('fileDelete', { fileId })
  }

  private checkFileId(fileId: string): ReturnType<typeof latticeFail> | null {
    if (typeof fileId !== 'string' || !FILE_ID_PATTERN.test(fileId)) {
      return latticeFail({
        status: 400,
        code: 'invalid_file_id',
        reason: 'fileId 必须是 UUID v4（服务端 F2/F3 都校验这个形状）',
        field: 'fileId',
        value: String(fileId),
      })
    }
    return null
  }
}
