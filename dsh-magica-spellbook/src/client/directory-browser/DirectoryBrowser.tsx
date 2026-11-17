/**
 * 嵌入式目录选择器（受控组件，不占任何 slot）。
 *
 * 从 dsh 官方 `ui-directory-picker-browse` 的组件 fork 并加固：
 * ① 全部输入走 props（不依赖 ui-workspace 服务）；② 落点记忆与宿主平台推断；③ 盘符快切。
 *
 * 不变量（见 `docs/design/04-client.zh.md` §1.3）：
 * - 同一时刻只有一个扫描有效（新扫描 abort 旧的，`requestSeq` 守卫所有 setState）；
 * - 导航落地不闪中间帧（目标腿 + 父腿合成一次两栏；父腿 200 ms 未回先落单栏，晚到升级）；
 * - 所有副作用可逆（卸载 / 关闭时 abort + 清计时器）。
 *
 * @module dsh-magica-spellbook/client/directory-browser
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { filterEntries, prefixWithin } from './filter.ts'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
// 图标全部来自 primitives 的真实组件；本目录自包含（发布时只带 src/client/directory-browser）
import {
  IconCheckOutlineRegular,
  IconChevronRightOutlineRegular,
  IconEditOutlineRegular,
  IconFolderCloseRegular,
  IconFolderOpenRegular,
  IconPlusOutlineRegular,
} from './icons.ts'
import css from './DirectoryBrowser.module.css'

/** 一行目录 / 一个面包屑。 */
export interface DirectoryEntry {
  name: string
  path: string
  hidden: boolean
}

/** 一层目录 + 其祖先链。 */
export interface DirectoryListing {
  path: string
  home: string
  crumbs: DirectoryEntry[]
  entries: DirectoryEntry[]
  truncated: boolean
}

/** 翻译函数形状。 */
export type Translate = (key: string, params?: Record<string, unknown>) => string

/** 组件入参（全部受控）。 */
export interface DirectoryBrowserProps {
  open: boolean
  listDirectory: (path?: string, signal?: AbortSignal) => Promise<DirectoryListing>
  createDirectory: (path: string, name: string) => Promise<string>
  onOpen: (path: string) => void
  onClose: () => void
  busy: boolean
  t: Translate
  onCommit?: (path: string) => Promise<void> | void
  footerExtra?: React.ReactElement
  onPathChange?: (path: string | null) => void
}

/** 父腿兜底等待（超过就先落单栏）。 */
const PARENT_LEG_WAIT_MS = 200
/** 慢扫描提示延迟。 */
const SLOW_SCAN_DELAY_MS = 300
/** 盘符请求超时。 */
const DRIVES_TIMEOUT_MS = 5_000
/** 盘符失败缓存时长（避免每次打开都重打 404）。 */
const DRIVES_FAIL_TTL_MS = 60_000

interface DrivesResult {
  at: number
  drives: string[]
  failed: boolean
}

const lastNavigatedPath: { value: string | null } = { value: null }
const drivesCache: { value: DrivesResult | null } = { value: null }
const hostHomeCache: { value: string | null } = { value: null }
/** `defaultTopLevel()` 的缓存（`undefined` 表示还没算过，`null` 表示"算不出来"）。 */
const topLevelCache: { value: string | null | undefined } = { value: undefined }

function hostIsWindows(): boolean {
  const home = hostHomeCache.value
  if (home === null) return false
  return /^[A-Za-z]:[\\/]/.test(home)
}

function rootOf(path: string): string | undefined {
  if (/^[A-Za-z]:[\\/]/.test(path)) return `${path.slice(0, 2)}\\`
  return path.startsWith('/') ? '/' : undefined
}

/**
 * 首屏落点。
 *
 * **算不出来就返回 `undefined`**（而不是硬落 `C:\` / `/`）：落根目录会把整块磁盘或整个文件系统
 * 当列表展示，既慢又容易误操作；`undefined` 让调用方走"空态 + 提示选择"。
 * 结果会缓存（`A-050/A-210`）。
 */
function defaultTopLevel(): string | undefined {
  if (topLevelCache.value !== undefined) return topLevelCache.value ?? undefined
  const home = hostHomeCache.value
  // home 还不知道时**不要**把 null 缓存下来：否则这一页里永远算不出平台根（b.md:592
  // 要求"第二次起能落到 C:\ 或 /"）
  if (home === null) return undefined
  topLevelCache.value = rootOf(home) ?? null
  return topLevelCache.value ?? undefined
}

/**
 * 错误文案（D8）：优先取 Host 的**业务错误**（{ rpcError: { message } }），
 * 这才是用户能看懂的那句；裸 Error.message 常常是 HTTP 500 之类。
 */
function failureText(cause: unknown): string {
  if (typeof cause === 'object' && cause !== null) {
    const rpc = (cause as { rpcError?: { message?: unknown } }).rpcError
    if (typeof rpc?.message === 'string' && rpc.message !== '') return rpc.message
  }
  return cause instanceof Error ? cause.message : String(cause)
}

function parentPathOf(path: string): string | null {
  const normalized = path.replace(/[\\/]+$/, '')
  if (normalized === '') return null
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  if (index < 0) return null
  const head = normalized.slice(0, index)
  if (/^[A-Za-z]:$/.test(head)) return `${head}\\`
  return head === '' ? '/' : head
}

function joinPath(base: string, name: string): string {
  if (base.endsWith('/') || base.endsWith('\\')) return `${base}${name}`
  const separator = /^[A-Za-z]:[\\/]/.test(base) ? '\\' : '/'
  return `${base}${separator}${name}`
}

/**
 * 嵌入式目录选择器。
 * @param props - 见 `DirectoryBrowserProps`。
 */
export function DirectoryBrowser(props: DirectoryBrowserProps): React.ReactElement | null {
  const { open, busy, t } = props
  const [listing, setListing] = useState<DirectoryListing | null>(null)
  const [parent, setParent] = useState<DirectoryListing | null>(null)
  const [selected, setSelected] = useState<DirectoryEntry | null>(null)
  const [loading, setLoading] = useState(false)
  const [showSlowHint, setShowSlowHint] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [draft, setDraft] = useState<string | null>(null)
  const [folderDraft, setFolderDraft] = useState<string | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [drives, setDrives] = useState<string[]>([])

  const requestSeq = useRef(0)
  /** 打开代际：关闭后异步回包不许再 setState（D7，旧实现 openGeneration）。 */
  const openGeneration = useRef(0)
  /** onCommit 进行中：冻结视图（D10，旧实现 committing）。 */
  const [committing, setCommitting] = useState(false)
  /** 内容区（焦点恢复时按 ria-current 找行，A-084/A-215）。 */
  const contentRef = useRef<HTMLDivElement | null>(null)
  /** 路径输入框（首屏焦点）。 */
  const pathInputRef = useRef<HTMLInputElement | null>(null)
  /** 落地下一步要把焦点放回行上。 */
  const rowFocusWant = useRef(false)
  const scanAbort = useRef<AbortController | null>(null)
  const parentTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const slowTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const listDirectoryRef = useRef(props.listDirectory)
  listDirectoryRef.current = props.listDirectory
  /** 最新的 props（`navigate` 依赖为空时靠它读取外部输入，避免身份抖动导致请求风暴）。 */
  const propsRef = useRef(props)
  propsRef.current = props

  const clearTimers = useCallback(() => {
    if (parentTimer.current !== null) {
      clearTimeout(parentTimer.current)
      parentTimer.current = null
    }
    if (slowTimer.current !== null) {
      clearTimeout(slowTimer.current)
      slowTimer.current = null
    }
  }, [])

  const navigate = useCallback(
    (target: string | undefined) => {
      const seq = requestSeq.current + 1
      requestSeq.current = seq
      scanAbort.current?.abort()
      const controller = new AbortController()
      scanAbort.current = controller

      setLoading(true)
      setShowSlowHint(false)
      setError(null)
      if (slowTimer.current !== null) clearTimeout(slowTimer.current)
      slowTimer.current = setTimeout(() => setShowSlowHint(true), SLOW_SCAN_DELAY_MS)

      // `undefined` 不是"别扫"，而是"**让宿主用自己的 homedir**"（A-210）：
      // `listDirectory` 的签名就是 `path?: string`，宿主按缺省解析。
      // 早前把 undefined 当空态直接返回，导致首次打开是纯白面板。
      const targetLeg = listDirectoryRef.current(target, controller.signal)
      const parentTarget = target === undefined ? null : parentPathOf(target)
      const parentLeg =
        parentTarget === null
          ? Promise.resolve(null)
          : // 父腿必须**立刻**挂上 catch：目标腿失败或 seq 过期时没人 await 它，
            // 否则就是一条 Uncaught (in promise)（真机上会被报成插件崩溃）
            listDirectoryRef.current(parentTarget, controller.signal).catch(() => null)

      void targetLeg
        .then(async (next) => {
          if (requestSeq.current !== seq) return
          hostHomeCache.value = next.home
          lastNavigatedPath.value = next.path
          propsRef.current.onPathChange?.(next.path)

          let landedParent: DirectoryListing | null = null
          let landed = false
          // 父腿最多等 200 ms：超时先落单栏，晚到的原地升级
          parentTimer.current = setTimeout(() => {
            if (requestSeq.current !== seq || landed) return
            landed = true
            setListing(next)
            setParent(null)
            setSelected(null)
            setLoading(false)
            setShowSlowHint(false)
          }, PARENT_LEG_WAIT_MS)

          try {
            landedParent = await parentLeg
          } catch {
            landedParent = null
          }
          if (parentTimer.current !== null) {
            clearTimeout(parentTimer.current)
            parentTimer.current = null
          }
          if (requestSeq.current !== seq) return
          landed = true
          setListing(next)
          setParent(landedParent)
          setSelected(null)
          setLoading(false)
          setShowSlowHint(false)
        })
        .catch((cause: unknown) => {
          if (requestSeq.current !== seq) return
          setLoading(false)
          setShowSlowHint(false)
          setError(failureText(cause))
        })
    },
    // 依赖固定为空：外部输入全走 propsRef。早前用 `[props]`，消费方每次重渲染都会换掉
    // navigate 身份 → 首屏 effect 重跑 → 双请求风暴（G1 核对表 P0-2）。
    [],
  )

  useEffect(() => {
    if (!open) return
    navigate(lastNavigatedPath.value ?? defaultTopLevel())
  }, [open, navigate])

  // 落地后把焦点放回"可操作的地方"（A-084/A-215）：
  // 有编辑中的路径就留在输入框；否则落到选中行（`aria-current` 就是锚点）。
  useEffect(() => {
    if (!open || listing === null) return
    if (draft !== null) return
    const row = contentRef.current?.querySelector<HTMLButtonElement>('button[aria-current="true"]')
    if (rowFocusWant.current) {
      rowFocusWant.current = false
      if (row !== null && row !== undefined) {
        row.focus()
        return
      }
    }
    // 扫描回包不应该把焦点从"正在别处操作的用户"手里抢走：
    // 只有焦点还落在 body 上（= 没人接管）时才补一次
    if (typeof document !== 'undefined' && document.activeElement === document.body) {
      row?.focus()
    }
  }, [open, listing, draft])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const cached = drivesCache.value
    if (cached !== null && (!cached.failed || Date.now() - cached.at < DRIVES_FAIL_TTL_MS)) {
      setDrives(cached.drives)
      return () => controller.abort()
    }
    const timer = setTimeout(() => controller.abort(), DRIVES_TIMEOUT_MS)
    void fetch('/cac/drives', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`drives ${response.status}`)
        const payload = (await response.json()) as { drives?: unknown }
        const list = Array.isArray(payload.drives)
          ? payload.drives.filter((item): item is string => typeof item === 'string')
          : []
        drivesCache.value = { at: Date.now(), drives: list, failed: false }
        setDrives(list)
      })
      .catch(() => {
        drivesCache.value = { at: Date.now(), drives: [], failed: true }
        setDrives([])
      })
      .finally(() => clearTimeout(timer))
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [open])

  useEffect(() => {
    if (open) return
    scanAbort.current?.abort()
    clearTimers()
    setDraft(null)
    setFolderDraft(null)
    setCreateError(null)
  }, [open, clearTimers])

  useEffect(() => () => {
    scanAbort.current?.abort()
    clearTimers()
  }, [clearTimers])

  if (!open) return null

  // 路径草稿只过滤**当前列**：不触发任何网络请求（预览腿在 0.2 明确不做）
  const visibleEntries = filterEntries(
    listing?.entries ?? [],
    draft === null ? '' : prefixWithin(listing?.path, draft),
    showHidden,
    selected?.path,
  )
  // 落点优先级：**选中项优先**（diff C14 / 旧实现 `:506`）。早前草稿优先——
  // 没按过 Enter 的路径也能被「打开」提交，等于跳过宿主的目录校验。
  // 想提交手输路径仍可以：先 Enter（会 navigate 过去），再打开。
  const targetPath = selected?.path ?? listing?.path ?? draft ?? null
  const emptyHint = !loading && error === null && listing === null
  // 盘符栏的 aria-label：翻译不到时不挂（防读屏念 key 原文，D10）
  const drivesLabel = t('browser.drives')
  const driveBarLabel = drivesLabel === 'browser.drives' ? null : drivesLabel
  const windowsHost = /^[A-Za-z]:[\\\\/]/.test(listing?.home ?? hostHomeCache.value ?? '')

  async function pick(): Promise<void> {
    if (targetPath === null) return
    if (props.onCommit !== undefined) {
      try {
        await props.onCommit(targetPath)
      } catch (cause) {
        setError(failureText(cause))
        return
      }
    }
    props.onOpen(targetPath)
  }

  async function confirmCreate(): Promise<void> {
    const base = listing?.path
    const name = folderDraft?.trim() ?? ''
    if (base === undefined || name === '') return
    setCreating(true)
    setCreateError(null)
    try {
      const created = await props.createDirectory(base, name)
      setFolderDraft(null)
      navigate(created)
    } catch (cause) {
      setCreateError(failureText(cause))
    } finally {
      setCreating(false)
    }
  }

  /** 忙碌 / 有草稿时拒绝关闭：点遮罩或按 Esc 不该丢掉正在做的事（A-253 / B-006）。 */
  const requestClose = (): void => {
    if (props.busy || creating || committing || draft !== null || folderDraft !== null) return
    props.onClose()
  }

  return (
    <Modal open={open} onClose={requestClose} title={t('browser.title')} className={css.dialog} headless>
      <div className={css.header}>
        <h2 className={css.title}>{t('browser.title')}</h2>
        <button
          type="button"
          className={css.iconButton}
          title={t('browser.editPath')}
          onClick={() => setDraft(listing?.path ?? '')}
        >
          <IconEditOutlineRegular size={14} />
        </button>
      </div>

      <div className={css.crumbBar}>
        {draft === null ? (
          (listing?.crumbs ?? []).map((crumb, index) => (
            <span key={crumb.path} className={css.crumbSeat}>
              {index > 0 ? <IconChevronRightOutlineRegular size={12} className={css.crumbChevron} /> : null}
              <button type="button" className={css.crumb} onClick={() => navigate(crumb.path)}>
                {crumb.name}
              </button>
            </span>
          ))
        ) : (
          <input
            className={css.pathInput}
            ref={pathInputRef}
            value={draft}
            autoFocus
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setDraft(null)
                return
              }
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) navigate(draft)
            }}
          />
        )}
      </div>

      {/* 盘符栏（D10）：没有盘符且不是 Windows 时给 POSIX `/` 兜底入口；
          aria-label 只在真的翻译到时才挂（否则读屏会念 key 原文） */}
      <div className={css.driveBar} {...(driveBarLabel === null ? {} : { 'aria-label': driveBarLabel })}>
        {(drives.length === 0 && !windowsHost ? ['/'] : drives).map((drive) => (
          <button
            key={drive}
            type="button"
            className={listing?.path.startsWith(drive) === true ? `${css.driveBtn} ${css.driveBtnActive}` : css.driveBtn}
            onClick={() => navigate(drive)}
          >
            {drive}
          </button>
        ))}
      </div>

      <div className={css.content} ref={contentRef}>
        {listing?.truncated === true ? (
          <div className={css.status} role="status">{t('browser.truncated')}</div>
        ) : null}
        {/* 首屏扫描失败/宿主还没返回时给一行提示，别留纯白面板（T9） */}
        {emptyHint ? (
          <div className={css.status} role="status">{t('browser.empty')}</div>
        ) : null}
        {parent === null ? null : (
          <>
            <div className={css.column} role="list" aria-label={t('browser.title')}>
              {(parent.entries ?? [])
                .filter((entry) => showHidden || !entry.hidden)
                .map((entry) => (
                  <button
                    key={entry.path}
                    type="button"
                    role="listitem"
                    aria-current={entry.path === listing?.path ? 'true' : undefined}
                    className={entry.path === listing?.path ? `${css.row} ${css.rowSelected}` : css.row}
                    onClick={() => {
                      rowFocusWant.current = true
                      navigate(entry.path)
                    }}
                  >
                    {entry.path === listing?.path ? (
                      <IconFolderOpenRegular size={16} className={css.rowIconSelected} />
                    ) : (
                      <IconFolderCloseRegular size={16} className={css.rowIcon} />
                    )}
                    <span className={css.rowName}>{entry.name}</span>
                    <IconChevronRightOutlineRegular size={12} className={css.rowChevron} />
                  </button>
                ))}
            </div>
            <div className={css.divider} />
          </>
        )}
        <div className={css.column} role="list" aria-label={t('browser.title')}>
          {visibleEntries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              role="listitem"
              aria-current={selected?.path === entry.path ? 'true' : undefined}
              className={selected?.path === entry.path ? `${css.row} ${css.rowSelected}` : css.row}
              disabled={committing}
              onClick={() => setSelected(entry)}
              onDoubleClick={() => navigate(entry.path)}
            >
              {selected?.path === entry.path ? (
                <IconFolderOpenRegular size={16} className={css.rowIconSelected} />
              ) : (
                <IconFolderCloseRegular size={16} className={css.rowIcon} />
              )}
              <span className={css.rowName}>{entry.name}</span>
            </button>
          ))}
          {loading && !showSlowHint ? null : loading ? <div className={css.loadingFloat}>{t('browser.loading')}</div> : null}
        </div>
      </div>

      <div className={css.footerBar}>
        <button
          type="button"
          className={showHidden ? `${css.showHiddenToggle} ${css.showHiddenToggleActive}` : css.showHiddenToggle}
          onClick={() => setShowHidden((value) => !value)}
        >
          <IconCheckOutlineRegular size={14} /> {t('browser.showHidden')}
        </button>
        <Button
          variant="outline"
          icon={<IconPlusOutlineRegular size={14} />}
          disabled={listing === null || loading || busy}
          onClick={() => setFolderDraft('')}
        >
          {t('browser.newFolder')}
        </Button>
        <span className={css.footerGap} />
        {props.footerExtra}
        <Button variant="outline" className={css.footerAction} disabled={busy} onClick={props.onClose}>
          {t('browser.cancel')}
        </Button>
        <Button
          variant="primary"
          className={css.footerAction}
          disabled={targetPath === null || loading || busy}
          onClick={() => void pick()}
        >
          {t('browser.open')}
        </Button>
      </div>
      {error === null ? null : <div className={css.error} role="alert">{error}</div>}

      <Modal
        open={folderDraft !== null}
        onClose={() => {
          if (!creating) setFolderDraft(null)
        }}
        title={t('browser.newFolder')}
        className={css.createDialog}
        headless
      >
        <div className={css.createBody}>
          <p className={css.createTitle}>{t('browser.newFolder')}</p>
          <input
            className={css.createInput}
            value={folderDraft ?? ''}
            autoFocus
            placeholder={t('browser.folderName')}
            onChange={(event) => setFolderDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) void confirmCreate()
            }}
          />
          {createError === null ? null : <div className={css.error} role="alert">{createError}</div>}
          <div className={css.createActions}>
            <Button variant="outline" disabled={creating} onClick={() => setFolderDraft(null)}>
              {t('browser.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={creating || (folderDraft ?? '').trim() === ''}
              onClick={() => void confirmCreate()}
            >
              {t('browser.create')}
            </Button>
          </div>
        </div>
      </Modal>
    </Modal>
  )
}
