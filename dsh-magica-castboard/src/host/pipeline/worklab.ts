/**
 * **worklab** -- the working directory shared by router sessions and portrait sessions.
 *
 * Layout (all relative to `$DSH_HOME`):
 *
 * - `storages/castboard/worklabs/`: the router's cwd;
 *   - `workspaces/index.md`: the index of all projects in this instance;
 *   - `workspaces/<workspaceId>.md`: one project's portrait;
 *   - `workspaces.json`: the portrait ledger (batches / sessions / progress, see `portrait/store.ts`);
 *   - `workspaces-custom.json`, `strategy-custom.json`: user-maintained guidance files.
 *
 * Input artifacts do not live here: they are under storages/castboard/attachments/<issueId>/ and registered in the
 * attachment manifest, because task sessions at execution time also find them by issueId, a different lifecycle from the router workbench.
 *
 * Except for pure functions, every public entry point here is **best effort**: a failed attachment download or
 * comment query only logs and never lets an exception escape into the router tick.
 *
 * @module dsh-magica-castboard/host/pipeline/worklab
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, parse, resolve } from 'node:path'

export const WORKLAB_DIR = 'storages/castboard/worklabs'

export const WORKLAB_PORTRAITS_DIR = `${WORKLAB_DIR}/workspaces`

export const WORKLAB_INDEX_FILE = `${WORKLAB_PORTRAITS_DIR}/index.md`

export const WORKLAB_RECORD_FILE = `${WORKLAB_DIR}/workspaces.json`

export const WORKLAB_WORKSPACES_CUSTOM_FILE = `${WORKLAB_DIR}/workspaces-custom.json`

export const WORKLAB_STRATEGY_CUSTOM_FILE = `${WORKLAB_DIR}/strategy-custom.json`

const ATTACHMENTS_DIR = 'storages/castboard/attachments'


function foldPath(path: string): string {
  return path.toLowerCase().replace(/[\\/]+$/, '')
}

/** Compare two **already folded** paths: `candidate` is `root` itself or lies under it. */
function withinFolded(root: string, candidate: string): boolean {
  return candidate === root
    || candidate.startsWith(`${root}\\`)
    || candidate.startsWith(`${root}/`)
}

function resolveCandidate(rawPath: string): string | undefined {
  const trimmed = rawPath.trim()
  if (trimmed === '') return undefined
  try {
    return resolve(trimmed)
  } catch {
    return undefined
  }
}

function hitsExactEntry(target: string, entries: readonly string[] | undefined): boolean {
  if (entries === undefined) return false
  const foldedTarget = foldPath(target)
  return entries.some(entry => {
    const value = entry.trim()
    return value !== '' && foldPath(resolve(value)) === foldedTarget
  })
}

/** Lies inside an entry's **subtree** (including the entry itself; case and trailing slashes ignored). */
function hitsSubtreeEntry(target: string, entries: readonly string[] | undefined): boolean {
  if (entries === undefined) return false
  const foldedTarget = foldPath(target)
  return entries.some(entry => {
    const value = entry.trim()
    return value !== '' && withinFolded(foldPath(resolve(value)), foldedTarget)
  })
}

/**
 * Exclusions for {@link isPortraitTarget}. The two semantics must not be merged:
 *
 * - `excludeSelf`: exclude only these paths **themselves**; subdirectories are still scanned (used for the home directory);
 * - `excludeSubtrees`: skip the path **and its whole subtree** (used for the workbench / artifact directories).
 */
export interface PortraitPathFilter {
  readonly excludeSelf?: readonly string[]
  readonly excludeSubtrees?: readonly string[]
}

interface TargetSnapshot {
  readonly target: string
  readonly root: string
  readonly filter: PortraitPathFilter
}

/** One rejection rule: true means this path gets no portrait. */
type TargetRejection = (snapshot: TargetSnapshot) => boolean

/**
 * Rejection rules, run in order; any hit excludes the path:
 *
 * 1. the whole Windows C: drive (Linux `root` is always `/`, so this never hits);
 * 2. a top-level drive itself (`D:\`, `/`);
 * 3. paths matched exactly by `excludeSelf`;
 * 4. subtrees covered by `excludeSubtrees`.
 *
 * On Linux, do **not** add a system-directory blacklist: the only hard constraint there is "top-level drive", and whatever entered the registry is a project.
 */
const TARGET_REJECTIONS: readonly TargetRejection[] = [
  snapshot => /^c:/i.test(snapshot.root),
  snapshot => foldPath(snapshot.target) === foldPath(snapshot.root),
  snapshot => hitsExactEntry(snapshot.target, snapshot.filter.excludeSelf),
  snapshot => hitsSubtreeEntry(snapshot.target, snapshot.filter.excludeSubtrees),
]

/**
 * Whether this path should get a portrait.
 *
 * The home directory excludes only itself, not its subtree: a service account's home is `/root` and all projects
 * live under it, so excluding the subtree would eat every project (this happened in production).
 *
 * @param rawPath - Path to judge (may be relative).
 * @param filter - Exclusions.
 * @returns true when a portrait should be written.
 */
export function isPortraitTarget(rawPath: string, filter: PortraitPathFilter): boolean {
  const target = resolveCandidate(rawPath)
  if (target === undefined) return false
  const root = parse(target).root
  if (root === '') return false
  const snapshot: TargetSnapshot = { target, root, filter }
  return !TARGET_REJECTIONS.some(rejects => rejects(snapshot))
}

/**
 * Drop **container directories**: when one registered workspace is the parent of another registered workspace,
 *
 * it is not a project. Judge only by the **registered set**, never guess the disk layout: when the registry contains
 * both `D:\projects-code\llm` and a repository under it, a portrait for the parent is wasted work, and the router could dispatch to the "container root".
 *
 * @param items - Filtered workspace list.
 * @returns The list without container directories (order preserved).
 */
export function dropContainerWorkspaces<T extends { path: string }>(items: readonly T[]): T[] {
  const folded = items.map(item => foldPath(item.path))
  return items.filter((_, index) => {
    const own = folded[index] ?? ''
    if (own === '') return true
    return !folded.some((candidate, candidateIndex) => (
      candidateIndex !== index
      && candidate !== ''
      && candidate !== own
      && withinFolded(own, candidate)
    ))
  })
}


export function portraitFileFor(home: string, workspaceId: string): string {
  return join(home, WORKLAB_PORTRAITS_DIR, `${workspaceId}.md`)
}

function attachmentTargetDir(home: string, issueId: string): string {
  return join(home, ATTACHMENTS_DIR, issueId, 'input')
}


export interface WorklabAttachment {
  readonly name: string
  readonly path: string
  readonly description?: string
  readonly size?: number
}

export interface WorklabComment {
  readonly author: string
  readonly content: string
  readonly at?: string
}

export interface IssueReferenceExtras {
  /** Persisted input artifacts; **an empty array = do not add the `<input_attachments>` tag**. */
  readonly attachments?: readonly WorklabAttachment[]
  /** This issue's comments; **an empty array = do not add the `<comments>` tag**. */
  readonly comments?: readonly WorklabComment[]
  readonly workspacesCatalog?: { readonly indexFile: string; readonly portraitDir: string }
}

type WorklabLog = (level: 'info' | 'warn', event: string, detail?: string) => void

export interface WorklabDeps {
  readonly home: string
  /** Current instance's workspace list (used to seed `index.md`). */
  readonly listWorkspaces: () => ReadonlyArray<{ id: string; path: string; title: string }>
  /** Download this issue's input artifacts into `outputDir`. Absent = no shared-library connection, skip. */
  readonly downloadAttachments?: (
    issueId: string,
    outputDir: string,
  ) => Promise<{ downloaded: readonly WorklabAttachment[]; failed: number }>
  readonly comments?: (issueId: string) => Promise<readonly WorklabComment[] | undefined>
  /** Register downloaded files in the manifest (execution time finds them by issueId). Absent = do not register. */
  readonly record?: (
    issueId: string,
    dir: string,
    files: readonly WorklabAttachment[],
  ) => Promise<void>
  /**
   * Root directory for input artifacts (default `<home>/storages/castboard/attachments`).
   *
   * The wiring layer passes `TaskAttachmentIndex`'s root: the manifest records paths as `<root>/attachments/<issueId>/`,
   * and the download directory must match, otherwise the same material lands in two places.
   */
  readonly attachmentsRoot?: string
  readonly log?: WorklabLog
}


interface PreparedExtras {
  attachments?: readonly WorklabAttachment[]
  comments?: readonly WorklabComment[]
  workspacesCatalog?: { indexFile: string; portraitDir: string }
}

/**
 * Prepare one issue's worklab content: refresh the project catalog + download input artifacts + query comments.
 *
 * The three steps each have their own try/catch; any failure only logs and **never blocks dispatch**.
 *
 * @param deps - See {@link WorklabDeps}.
 * @param issueId - Target issue.
 * @returns Extras used to render references (never throws).
 */
export async function prepareWorklab(deps: WorklabDeps, issueId: string): Promise<IssueReferenceExtras> {
  const extras: PreparedExtras = {}
  const log: WorklabLog = (level, event, detail) => { deps.log?.(level, event, detail) }
  await refreshWorkspaceCatalog(extras, deps, log)
  await collectAttachmentFiles(extras, deps, issueId, log)
  await collectComments(extras, deps, issueId, log)
  return extras
}

async function refreshWorkspaceCatalog(
  extras: PreparedExtras,
  deps: WorklabDeps,
  log: WorklabLog,
): Promise<void> {
  try {
    extras.workspacesCatalog = await ensureWorkspaceCatalog(deps.home, deps.listWorkspaces)
  } catch (error) {
    log('warn', 'worklab-catalog-failed', messageOfError(error))
  }
}

/**
 * Input artifacts: the directory is **always** created (even when empty, so a subagent sees there are no attachments),
 * but the tag is added only when files really arrived; arrived files are registered in the manifest (execution time finds them by it).
 */
async function collectAttachmentFiles(
  extras: PreparedExtras,
  deps: WorklabDeps,
  issueId: string,
  log: WorklabLog,
): Promise<void> {
  const download = deps.downloadAttachments
  if (download === undefined) return
  const outputDir = deps.attachmentsRoot === undefined
    ? attachmentTargetDir(deps.home, issueId)
    : join(deps.attachmentsRoot, issueId, 'input')
  try {
    await mkdir(outputDir, { recursive: true })
    const { downloaded, failed } = await download(issueId, outputDir)
    if (downloaded.length === 0) {
      // Diagnostic: no input artifacts this time (output artifacts do not count). **Not registered** -- the manifest holds real files only.
      log('info', 'worklab-attachments-none', `${issueId}：上游没有可用的输入件（output 产物不算输入件）`)
    } else {
      extras.attachments = downloaded
      log('info', 'worklab-attachments', `${issueId}：${String(downloaded.length)} 个输入件 → ${outputDir}`)
      await recordAttachmentFiles(deps, issueId, outputDir, downloaded, log)
    }
    if (failed > 0) {
      log('warn', 'worklab-attachments-partial', `${issueId}：${String(failed)} 个附件下载失败`)
    }
  } catch (error) {
    log('warn', 'worklab-attachments-failed', `${issueId}：${messageOfError(error)}`)
  }
}

/** Register input files; a failed registration only warns and does not affect files already on disk. */
async function recordAttachmentFiles(
  deps: WorklabDeps,
  issueId: string,
  outputDir: string,
  files: readonly WorklabAttachment[],
  log: WorklabLog,
): Promise<void> {
  if (deps.record === undefined) return
  try {
    await deps.record(issueId, outputDir, files)
  } catch (error) {
    log('warn', 'worklab-attachments-record-failed', `${issueId}：${messageOfError(error)}`)
  }
}

async function collectComments(
  extras: PreparedExtras,
  deps: WorklabDeps,
  issueId: string,
  log: WorklabLog,
): Promise<void> {
  const comments = deps.comments
  if (comments === undefined) return
  try {
    const list = await comments(issueId)
    if (list !== undefined && list.length > 0) extras.comments = list
  } catch (error) {
    log('warn', 'worklab-comments-failed', `${issueId}：${messageOfError(error)}`)
  }
}


const CATALOG_PREAMBLE = `# workspace 清单索引

> 用途：**给 router 判断「这条 issue 该交给哪个 workspace」**。先读本文件 —— 目标是一眼
> 就能定下 80% 的归属；两个项目都像的时候，再去读对应肖像 \`./<workspaceId>.md\`。
>
> 每个项目**必须**有两个关键字段：\`workspaceId\` 与 \`cwd\`（项目绝对路径）——
> router 会把 cwd **逐字**填进 task，写错一个字就等于把活派到错的仓库。
> \`workspaceId\` 是 dsh 分配的 **UUID**（36 字符，\`8-4-4-4-12\`），不是 \`ws-xxx\` 这类自造名字；
> 这两个值由宿主播种时给准，维护时**照抄，不要改写**（别换成相对路径、别加引号/反引号、别自造 id）。
>
> 维护方式：由「项目肖像」会话**增量更新**。宿主只在缺失/为空时播种，之后不再改动。
> 每个项目有两处要写：下面一览表里**本行**的「一句话职责」，以及后面**本项目那一段**。

## 一览

| workspaceId | 标题 | cwd（绝对路径） | 一句话职责 |
|---|---|---|---|`

const EMPTY_OVERVIEW_ROW = '| （无） | — | — | （待补） |'

const PORTRAIT_STUB_TAIL = `- 能做什么：（待补）
- 关键词：（待补）
- 适合接的活：（待补）
- 不适合（容易误派的近似领域）：（待补）
- 肖像：—`

/** Indexes confirmed to "have content" (in-process cache, so the hot path stops reading disk). */
const confirmedIndexes = new Set<string>()

interface CatalogLayout {
  readonly worklabDir: string
  readonly portraitDir: string
  readonly indexFile: string
}

interface CatalogPaths {
  readonly indexFile: string
  readonly portraitDir: string
}

interface WorkspaceSummary {
  readonly id: string
  readonly path: string
  readonly title: string
}

function catalogLayoutFor(home: string): CatalogLayout {
  return {
    worklabDir: join(home, WORKLAB_DIR),
    portraitDir: join(home, WORKLAB_PORTRAITS_DIR),
    indexFile: join(home, WORKLAB_INDEX_FILE),
  }
}

function catalogPathsOf(layout: CatalogLayout): CatalogPaths {
  return { indexFile: layout.indexFile, portraitDir: layout.portraitDir }
}

async function createCatalogDirectories(layout: CatalogLayout): Promise<void> {
  await mkdir(layout.worklabDir, { recursive: true })
  await mkdir(layout.portraitDir, { recursive: true })
}

/** Whether the index exists and **has content** (a 0-byte placeholder counts as "no content"). */
async function fileHasContent(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && (await readFile(path, 'utf8')).trim() !== ''
  } catch {
    return false
  }
}

/** Escape a markdown table cell (`|` breaks the table, newlines break the row). */
function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
}

function renderOverviewRow(workspace: WorkspaceSummary): string {
  return `| ${workspace.id} | ${escapeTableCell(workspace.title)} | ${escapeTableCell(workspace.path)} | （待补） |`
}

function renderPortraitStub(workspace: WorkspaceSummary): string {
  const escapedTitle = escapeTableCell(workspace.title)
  return [
    `## ${workspace.id}（${escapedTitle === '' ? '（无标题）' : escapedTitle}）`,
    '',
    `- workspaceId：${workspace.id}`,
    `- cwd（绝对路径）：${workspace.path}`,
    PORTRAIT_STUB_TAIL,
  ].join('\n')
}

function renderCatalogSeed(source: ReadonlyArray<WorkspaceSummary>): string {
  const workspaces = [...source].sort((left, right) => left.path.localeCompare(right.path))
  const blocks: string[] = [CATALOG_PREAMBLE]
  blocks.push(...workspaces.map(renderOverviewRow))
  if (workspaces.length === 0) blocks.push(EMPTY_OVERVIEW_ROW)
  blocks.push('')
  for (const workspace of workspaces) {
    blocks.push(renderPortraitStub(workspace), '')
  }
  return blocks.join('\n')
}

/**
 * Make sure the portrait directory exists, and seed a skeleton only when the index **has no content**.
 *
 * `index.md` is the router's main basis for choosing a cwd, and only a portrait session that has really read a
 * project can write it, so the session owns it: the host only creates the directory and provides a stable starting
 * skeleton when it is missing or empty; **when there is content, not one byte is changed**.
 *
 * Once the index is confirmed to have content it is cached in-process, so later router ticks do not read disk again.
 *
 * @param home - `$DSH_HOME`.
 * @param listWorkspaces - Current instance's workspace list.
 * @returns The two absolute paths used to render references.
 */
export async function ensureWorkspaceCatalog(
  home: string,
  listWorkspaces: () => ReadonlyArray<{ id: string; path: string; title: string }>,
): Promise<{ indexFile: string; portraitDir: string }> {
  const layout = catalogLayoutFor(home)
  if (confirmedIndexes.has(layout.indexFile)) return catalogPathsOf(layout)
  await createCatalogDirectories(layout)
  if (!(await fileHasContent(layout.indexFile))) {
    await writeFile(layout.indexFile, renderCatalogSeed(listWorkspaces()), 'utf8')
  }
  confirmedIndexes.add(layout.indexFile)
  return catalogPathsOf(layout)
}

function messageOfError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
