/**
 * 会话台账：`$DSH_HOME/storages/magica/sessions/<sessionId>.json`。
 *
 * 台账是「可续跑」的**唯一凭证** —— dsh 的会话日志只记模型看到的东西，不记「谁用什么参数建起来的」。
 *
 * 两条铁律：
 * - `put`：先写盘（tmp + rename）成功，再更新内存缓存；
 * - `remove`：先删盘、成功后再删缓存（反过来会留下「内存没了、磁盘还在」→ 续跑变新建、丢上下文）。
 *
 * @module dsh-magica-spellbook/sessions/store
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { serviceOf, type DshHomePath } from '../shared/dsh.ts'

/** 台账版本（只拒 `>`）。 */
export const STORE_VERSION = 1

/** 台账子目录名。 */
export const STORE_SUBDIR = 'sessions'

/** 文件名允许的字符集（读 / 写 / 删都过它）。 */
export const SAFE_ID = /^[A-Za-z0-9._-]{1,200}$/

/** 会话种类（跨门面误用的判定依据）。 */
export type SessionKind = 'ephemeral' | 'workspace'

/** 台账里的模型路由。 */
export interface SessionRecordModel {
  provider: string
  model: string
  /** 只有临时会话会写。 */
  reasoningEffort?: string
}

/** 一条台账记录（13 个字段）。 */
export interface SessionRecord {
  version: number
  sessionId: string
  kind: SessionKind
  createdAt: number
  updatedAt: number
  model?: SessionRecordModel
  /** 预设名 / 沙箱模式名（两者取值相同）。 */
  permission?: string
  /** 仅 ephemeral。 */
  cwd?: string
  /** 仅 workspace。 */
  workspaceId?: string
  /** 仅 workspace。 */
  workspacePath?: string
  agentPresetId?: string
  /** 仅 workspace。 */
  title?: string
  /** 创建时用过自定义 `setup`（续跑必须重传）。 */
  customSetup?: boolean
}

/** 单文件损坏记录（诊断用）。 */
export interface SessionRecordLoadError {
  path: string
  message: string
}

const OPTIONAL_STRING_FIELDS = [
  'permission',
  'cwd',
  'workspaceId',
  'workspacePath',
  'agentPresetId',
  'title',
] as const

type OptionalStringField = (typeof OPTIONAL_STRING_FIELDS)[number]

function asModel(value: unknown): SessionRecordModel | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
  if (typeof candidate.provider !== 'string' || typeof candidate.model !== 'string') return undefined
  const model: SessionRecordModel = { provider: candidate.provider, model: candidate.model }
  if (typeof candidate.reasoningEffort === 'string' && candidate.reasoningEffort !== '') {
    model.reasoningEffort = candidate.reasoningEffort
  }
  return model
}

function asRecord(value: unknown): SessionRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const raw = value as Record<string, unknown>
  const sessionId = raw['sessionId']
  const kind = raw['kind']
  if (typeof sessionId !== 'string' || sessionId === '') return null
  if (kind !== 'ephemeral' && kind !== 'workspace') return null
  const versionRaw = raw['version']
  const record: SessionRecord = {
    version: typeof versionRaw === 'number' ? versionRaw : STORE_VERSION,
    sessionId,
    kind,
    createdAt: typeof raw['createdAt'] === 'number' && Number.isFinite(raw['createdAt']) ? raw['createdAt'] : 0,
    updatedAt: 0,
  }
  const updatedAt = raw['updatedAt']
  record.updatedAt = typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : record.createdAt
  const model = asModel(raw['model'])
  if (model !== undefined) record.model = model
  for (const field of OPTIONAL_STRING_FIELDS) {
    const candidate = raw[field]
    if (typeof candidate === 'string' && candidate !== '') record[field] = candidate
  }
  if (raw['customSetup'] === true) record.customSetup = true
  return record
}

/** 解析 `$DSH_HOME`（缺省 `~/.dsh`）—— 只认 dsh 提供的函数，不自己实现那套优先级。 */
export function resolveStoreDir(ctx: unknown, override?: string): string {
  if (override !== undefined && override !== '') return override
  const home = serviceOf<DshHomePath>(ctx, 'dshHomePath')
  if (typeof home === 'function') return join(home('storages', 'magica'), STORE_SUBDIR)
  throw new Error(
    'session store needs ctx.dshHomePath (provided by @deepseek-ai/dsh-app-boot); '
      + 'pass `storeDir` explicitly when running outside a full dsh composition',
  )
}

/** 会话 id → 文件名（字符集不合规直接抛）。 */
export function recordFileName(sessionId: string): string {
  if (!SAFE_ID.test(sessionId)) {
    throw new Error(
      `session id "${sessionId}" is not usable as a store file name `
        + '(allowed: A-Z a-z 0-9 . _ -, length 1-200)',
    )
  }
  return `${sessionId}.json`
}

/** 一个目录下的台账（进程内按目录单例）。 */
export class SessionRecordStore {
  readonly sessionsDir: string
  private readonly records = new Map<string, SessionRecord>()
  private readonly errors: SessionRecordLoadError[] = []
  private readonly errorPaths = new Set<string>()
  private loaded = false
  private dirReady = false

  constructor(dir: string) {
    this.sessionsDir = dir
  }

  /** 载入过程中遇到的损坏记录（诊断入口；会触发一次全量扫描）。 */
  get loadErrors(): readonly SessionRecordLoadError[] {
    this.ensureLoaded()
    return this.errors
  }

  private recordError(path: string, message: string): void {
    if (this.errorPaths.has(path)) return
    this.errorPaths.add(path)
    this.errors.push({ path, message })
  }

  private ensureDir(): void {
    if (this.dirReady) return
    mkdirSync(this.sessionsDir, { recursive: true })
    this.dirReady = true
  }

  private parseOne(path: string, text: string): SessionRecord | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(text) as unknown
    } catch (error) {
      this.recordError(path, error instanceof Error ? error.message : String(error))
      return null
    }
    const record = asRecord(parsed)
    if (record === null) {
      this.recordError(path, 'not a session record (missing sessionId / kind)')
      return null
    }
    if (record.version > STORE_VERSION) {
      this.recordError(
        path,
        `record version ${record.version} is newer than this build supports (${STORE_VERSION})`,
      )
      return null
    }
    return record
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    let names: string[]
    try {
      names = readdirSync(this.sessionsDir)
    } catch {
      return
    }
    for (const name of names) {
      if (!name.endsWith('.json')) continue
      const path = join(this.sessionsDir, name)
      try {
        const record = this.parseOne(path, readFileSync(path, 'utf8'))
        if (record !== null) this.records.set(record.sessionId, record)
      } catch {
        // 目录扫描期间文件可能被删：跳过
      }
    }
  }

  /** 单文件直读（不扫目录：这是续跑热路径）。 */
  get(sessionId: string): SessionRecord | null {
    const cached = this.records.get(sessionId)
    if (cached !== undefined) return cached
    let name: string
    try {
      name = recordFileName(sessionId)
    } catch {
      return null
    }
    const path = join(this.sessionsDir, name)
    let text: string
    try {
      text = readFileSync(path, 'utf8')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      // 只有 ENOENT 等价于「台账里没有」
      if (code !== 'ENOENT') this.recordError(path, `read failed (${code ?? 'unknown'}): ${String(error)}`)
      return null
    }
    const record = this.parseOne(path, text)
    if (record !== null) this.records.set(record.sessionId, record)
    return record
  }

  /** 全部记录（按 `createdAt` 降序）。 */
  list(): SessionRecord[] {
    this.ensureLoaded()
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 原子写：先写 tmp、rename，再更新缓存。 */
  put(input: Omit<SessionRecord, 'version' | 'updatedAt'> & { updatedAt?: number }): SessionRecord {
    this.ensureDir()
    const stored: SessionRecord = {
      // 白名单投影：台账是**契约文件**，不能让调用方顺手塞进来的字段落盘
      // （历史 bug：`as never` 塞进来的未知字段会原样写进 JSON）
      sessionId: input.sessionId,
      kind: input.kind,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt ?? Date.now(),
      version: STORE_VERSION,
      ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.permission !== undefined ? { permission: input.permission } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
      ...(input.workspacePath !== undefined ? { workspacePath: input.workspacePath } : {}),
      ...(input.agentPresetId !== undefined ? { agentPresetId: input.agentPresetId } : {}),
      ...(input.customSetup !== undefined ? { customSetup: input.customSetup } : {}),
    }
    const target = join(this.sessionsDir, recordFileName(stored.sessionId))
    const tmp = `${target}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}`
    writeFileSync(tmp, `${JSON.stringify(stored, null, 2)}\n`, 'utf8')
    renameSync(tmp, target)
    this.records.set(stored.sessionId, stored)
    return stored
  }

  /** 删除：先删盘、成功后再删缓存。 */
  remove(sessionId: string): boolean {
    let name: string
    try {
      name = recordFileName(sessionId)
    } catch {
      return false
    }
    const path = join(this.sessionsDir, name)
    if (!existsSync(path)) {
      this.records.delete(sessionId)
      return false
    }
    try {
      rmSync(path, { force: true })
    } catch {
      return false
    }
    this.records.delete(sessionId)
    return true
  }
}

const stores = new Map<string, SessionRecordStore>()

/** 取目录对应的台账单例；目录解析不出来时返回 `null`（降级，不抛）。 */
export function getSessionStore(ctx: unknown, override?: string): SessionRecordStore | null {
  let dir: string
  try {
    dir = resolveStoreDir(ctx, override)
  } catch {
    return null
  }
  let store = stores.get(dir)
  if (store === undefined) {
    store = new SessionRecordStore(dir)
    stores.set(dir, store)
  }
  return store
}

/** 读一条台账记录（台账不可用时返回 `null`）。 */
export function getSessionRecord(
  ctx: unknown,
  sessionId: string,
  override?: string,
): SessionRecord | null {
  return getSessionStore(ctx, override)?.get(sessionId) ?? null
}

/** 读全部台账记录（台账不可用时返回空数组）。 */
export function listSessionRecords(ctx: unknown, override?: string): SessionRecord[] {
  return getSessionStore(ctx, override)?.list() ?? []
}

/** 删除一条台账记录（台账不可用时返回 `false`）。 */
export function deleteSessionRecord(
  ctx: unknown,
  sessionId: string,
  override?: string,
): boolean {
  return getSessionStore(ctx, override)?.remove(sessionId) ?? false
}

/** 丢掉进程内单例（测试 / 外部改了文件时用）。 */
export function resetSessionStores(): void {
  stores.clear()
}
