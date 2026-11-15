/**
 * 内置 skill：把本包 `resources/<name>/SKILL.md` 注册成 **全局 skill**。
 *
 * 为什么走 `ctx.skills.registerProvider`（而不是 `ctx.skills.register`）：
 * - `register` 是把一条 skill 塞进某个 **layer 的 runtime 槽**，正文字符串要在注册时就成常量；
 * - `registerProvider` 是「来源」，`list()` 只给目录行、`get()` 才读盘 ⇒ 改 `SKILL.md`
 *   立刻生效（零缓存），也天然支持以后加第二个内置 skill（目录即 skill）；
 * - provider 注册在**插件根 ctx**（全局层），所以每个 agent 的 `snapshot({scope})` 都能看到，
 *   等价于「全局注册」——与 `dsh` 自带 bundled skill 同级（rank 600）。
 *
 * 反例参照：本仓 `sandore/packages/workflow/skill-provider.ts` 用的是同一套模式，
 * 接口形状对齐 DSH `SkillRegistry.registerProvider`（`skill/src/index.ts:390-431`）。
 *
 * **绝不抛**：`skills` 服务缺席、provider 重名、单份 SKILL.md 坏掉，都只 warn 并降级 ——
 * skill 注册失败不能把整个插件拖进 FAILED。
 * @module dsh-magica-rune/builtin-skill
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { DshContext, DshSkills } from './shared/dsh.ts'

/** provider 名：`SkillCandidate.provider` 必须恒等于它（DSH 用它做重复计数与诊断）。 */
export const BUILTIN_SKILL_PROVIDER = 'dsh-magica-rune'

/**
 * 目录 rank：600 = bundled 层（**与 DSH 导出的 `BUNDLED_SKILL_RANK` 同值**，
 * `packages/skill/skill/src/index.ts:28`；测试里会与真值对拍，防止漂移）。
 *
 * 排名语义是「**小者胜**」：project-dsh/project-agents 100/200 < runtime 250 < bundled 600。
 * 所以随包分发的 skill 不会抢用户自己写进项目的同名 skill，也不会被普通 plugin 抢走。
 */
export const BUILTIN_SKILL_RANK = 600

/**
 * catalog 面 description 的自截断上限（480 < `tool-skill` 的 `catalogDescriptionMaxLength` 500）。
 * 目录是**每轮常驻**的 prompt 开销，自己截带省略号，好过被 DSH 二次截断（那里没有省略号）。
 * `get()` 返回的 description 不截。
 */
export const SKILL_CATALOG_DESCRIPTION_MAX_LENGTH = 480

/** DSH 目录发现只认「根下 `<name>.md`」或「根下 `<dir>/SKILL.md`」。 */
const SKILL_FILE_NAME = 'SKILL.md'

const FRONTMATTER_FENCE = '---'

/** skill 名语法（与 DSH `skill/src/index.ts` 的 `SKILL_NAME` 同一条正则）。 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** `resources/` 下允许出现的 skill 目录（一个目录一个 skill）。 */
export const RESOURCES_DIR = 'resources'

// ── 与 DSH skill 服务对齐的最小结构面 ────────────────────────────────

export interface SkillInvocationLike {
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
}

export interface SkillResourceBaseLike {
  readonly kind: 'directory'
  readonly path: string
}

export interface SkillCandidateLike {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly invocation: SkillInvocationLike
  readonly source: string
  readonly provider: string
  readonly resourceBase?: SkillResourceBaseLike
  readonly rank: number
  readonly locator: unknown
  readonly path?: string
}

export interface SkillDefinitionLike extends SkillCandidateLike {
  readonly content: string
}

export interface SkillLookupOptionsLike {
  readonly cwd?: string | undefined
  readonly signal?: AbortSignal | undefined
}

export interface SkillProviderControlLike {
  readonly signal: AbortSignal
  readonly invalidate: () => void
}

export interface SkillProviderLike {
  readonly name: string
  readonly list: (options: SkillLookupOptionsLike) => Promise<readonly SkillCandidateLike[]>
  readonly get: (
    candidate: SkillCandidateLike, options: SkillLookupOptionsLike,
  ) => Promise<SkillDefinitionLike | undefined>
}

// ── frontmatter 解析（纯函数，可单测） ───────────────────────────────

export interface ParsedSkillSource {
  readonly name: string
  readonly description: string
  readonly whenToUse?: string
  readonly modelInvocable: boolean
  readonly userInvocable: boolean
  /** 去掉 frontmatter 后的正文（未 trim）。 */
  readonly body: string
}

/**
 * 解析一份 `SKILL.md`。
 *
 * 契约（任一条不满足就**抛**，`list()` 会跳过该 skill）：
 * - 文件必须以 `---` 围栏开头，且有闭合围栏；
 * - `name` 必填、kebab-case、**必须等于所在目录名**（目录即身份，避免文件与目录说两套）；
 * - `description` 必填非空；
 * - `whenToUse?` 非空字符串才算；
 * - 调用控制：`modelInvocable = disable-model-invocation !== true`；
 *   `userInvocable` 优先 `disable-user-invocation`，其次 DSH 规范键 `user-invocable`（缺省 true）。
 *
 * 只认**单行标量**：本仓内置 skill 的 frontmatter 就三行，为此引一个 YAML 依赖不划算。
 * @param raw - 文件原文（容忍 UTF-8 BOM 与 CRLF）。
 * @param directoryName - 该文件所在目录名（= skill 目录名）。
 * @returns 解析结果。
 */
export function parseSkillSource(raw: string, directoryName: string): ParsedSkillSource {
  const { yamlText, body } = splitFrontmatter(raw)

  const name = readScalar(yamlText, 'name')
  if (name === undefined) throw new Error('frontmatter field "name" must be a non-empty string')
  if (!SKILL_NAME_PATTERN.test(name)) {
    throw new Error(`frontmatter field "name" ('${name}') must be kebab-case (${String(SKILL_NAME_PATTERN)})`)
  }
  if (name !== directoryName) {
    throw new Error(`frontmatter field "name" ('${name}') must match its directory name ('${directoryName}')`)
  }
  const description = readScalar(yamlText, 'description')
  if (description === undefined) throw new Error('frontmatter field "description" must be a non-empty string')

  const whenToUse = readScalar(yamlText, 'whenToUse')
  const disableUserInvocation = readBoolean(yamlText, 'disable-user-invocation')
  const canonicalUserInvocable = readBoolean(yamlText, 'user-invocable')

  return {
    name,
    description,
    ...(whenToUse === undefined ? {} : { whenToUse }),
    modelInvocable: readBoolean(yamlText, 'disable-model-invocation') !== true,
    userInvocable: disableUserInvocation === undefined
      ? canonicalUserInvocable !== false
      : disableUserInvocation !== true,
    body,
  }
}

/** 拆 frontmatter 与正文；缺围栏即抛。 */
function splitFrontmatter(raw: string): { yamlText: string; body: string } {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  const firstLineEnd = text.indexOf('\n')
  if (firstLineEnd < 0 || text.slice(0, firstLineEnd).replace(/\r$/, '') !== FRONTMATTER_FENCE) {
    throw new Error(`missing YAML frontmatter (the file must start with a '${FRONTMATTER_FENCE}' fence)`)
  }
  let lineStart = firstLineEnd + 1
  while (lineStart <= text.length) {
    const newline = text.indexOf('\n', lineStart)
    const lineEnd = newline < 0 ? text.length : newline
    if (text.slice(lineStart, lineEnd).replace(/\r$/, '') === FRONTMATTER_FENCE) {
      return {
        yamlText: text.slice(firstLineEnd + 1, lineStart),
        body: text.slice(newline < 0 ? text.length : newline + 1),
      }
    }
    if (newline < 0) break
    lineStart = newline + 1
  }
  throw new Error(`missing closing '${FRONTMATTER_FENCE}' fence for the YAML frontmatter`)
}

/** 取一个单行标量（去引号；空串当缺失）。 */
function readScalar(yamlText: string, key: string): string | undefined {
  const matched = new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm').exec(yamlText)?.[1]
  if (matched === undefined) return undefined
  const value = matched.trim().replace(/^['"]|['"]$/g, '').trim()
  return value === '' ? undefined : value
}

/** 取一个布尔标量（`true`/`false`；其它值当缺失）。 */
function readBoolean(yamlText: string, key: string): boolean | undefined {
  const value = readScalar(yamlText, key)?.toLowerCase()
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** catalog 面 description 自截断。 */
function catalogDescription(description: string): string {
  if (description.length <= SKILL_CATALOG_DESCRIPTION_MAX_LENGTH) return description
  return `${description.slice(0, SKILL_CATALOG_DESCRIPTION_MAX_LENGTH - 1)}…`
}

// ── 资源定位与 provider ─────────────────────────────────────────────

/**
 * `resources/` 的绝对路径（相对 **bundle 位置** `lib/index.js`，也兼容源码树 `src/`）。
 *
 * 包内 link/发布两种形态都成立：`lib/index.js` 与 `resources/` 是同级目录。
 * 这也是 `package.json.files` 必须包含 `resources` 的原因。
 */
export function resourcesDirUrl(): URL {
  return new URL(`../${RESOURCES_DIR}/`, import.meta.url)
}



/**
 * 目录发现式 provider：`resources/` 下每个含 `SKILL.md` 的子目录都是一个 skill。
 * 单个目录坏掉只跳过它，不阻断同批其它 skill。
 *
 * **目录行缓存**（SKILL §2.1：热路径 + 轻 I/O 首选缓存）：`list()` 会在每次 skill
 * snapshot 时被调用，`readdirSync` + `readFileSync` 逐次执行属于「热路径 + 轻 I/O」。
 * 这里只缓存**候选列表**（名字/描述），但**不缓存正文**——`get()` 仍然每次读盘，
 * 所以模型真正加载时拿到的一定是文件当前内容；目录结构变化由 `control.invalidate`
 * （或 provider 重注册）触发重扫。
 */
export function builtinSkillProvider(
  ctx: DshContext,
  rootUrl: URL = resourcesDirUrl(),
  control?: SkillProviderControlLike,
): SkillProviderLike {
  const root = fileURLToPath(rootUrl)
  let cached: SkillCandidateLike[] | undefined
  const reset = (): void => { cached = undefined }
  control?.signal.addEventListener('abort', reset, { once: true })

  const provider: SkillProviderLike = {
    name: BUILTIN_SKILL_PROVIDER,
    list: async () => {
      if (cached !== undefined) return cached
      if (!existsSync(root)) {
        // 目录还没出现：不写缓存，下次调用再试
        ctx.logger.warn(`[rune] bundled skill root missing: ${root}`)
        return []
      }
      const candidates: SkillCandidateLike[] = []
      let directoryNames: string[] = []
      try {
        directoryNames = readdirSync(root, { withFileTypes: true })
          .filter(entry => entry.isDirectory())
          .map(entry => entry.name)
      } catch (error) {
        ctx.logger.warn(`[rune] bundled skill discovery failed under ${root}: ${String(error)}`)
        return []
      }
      for (const directoryName of directoryNames) {
        const dir = join(root, directoryName)
        const skillFile = join(dir, SKILL_FILE_NAME)
        try {
          const parsed = parseSkillSource(readFileSync(skillFile, 'utf8'), directoryName)
          candidates.push({
            name: parsed.name,
            description: catalogDescription(parsed.description),
            ...(parsed.whenToUse === undefined ? {} : { whenToUse: parsed.whenToUse }),
            invocation: { modelInvocable: parsed.modelInvocable, userInvocable: parsed.userInvocable },
            source: 'bundled',
            provider: BUILTIN_SKILL_PROVIDER,
            resourceBase: { kind: 'directory', path: dir },
            rank: BUILTIN_SKILL_RANK,
            // locator = SKILL.md 的绝对路径（与 DSH 官方 bundled skill 的 shape 一致）。
            locator: skillFile,
            path: skillFile,
          })
        } catch (error) {
          ctx.logger.warn(`[rune] bundled skill "${directoryName}" skipped: ${String(error)}`)
        }
      }
      cached = candidates
      return candidates
    },
    /** 读正文：**每次读盘、零缓存**（`SKILL.md` 很小，「改了立刻生效」比省这一次读更值）。 */
    get: async (candidate: SkillCandidateLike) => {
      const skillFile = typeof candidate.locator === 'string' ? candidate.locator : undefined
      if (skillFile === undefined) {
        ctx.logger.warn(`[rune] skill "${candidate.name}" has no skill file locator`)
        return undefined
      }
      try {
        const parsed = parseSkillSource(readFileSync(skillFile, 'utf8'), basename(dirname(skillFile)))
        return {
          ...candidate,
          // 正文面用**未截断**的 description。
          description: parsed.description,
          content: parsed.body.trim(),
        }
      } catch (error) {
        ctx.logger.warn(`[rune] skill "${candidate.name}" body unreadable: ${String(error)}`)
        return undefined
      }
    },
  }
  return provider
}

/**
 * 注册内置 skill（插件加载时调用一次）。
 *
 * 注册在**插件根 ctx** → 全局层 → 所有 agent 可见。绝不抛。
 * @param ctx - 插件上下文。
 * @param options - 覆盖资源根（测试用）。
 * @returns 注销 provider 的 disposer（不可用时是 no-op）。
 */
export function registerBuiltinSkill(
  ctx: DshContext, options: { rootUrl?: URL } = {},
): () => void {
  const skills = ctx.get<DshSkills & {
    registerProvider(create: (control: SkillProviderControlLike) => SkillProviderLike): () => void
  }>('skills')
  if (skills === undefined) {
    ctx.logger.warn('[rune] skills service absent; bundled skill is not registered')
    return () => {}
  }
  try {
    return skills.registerProvider(control => builtinSkillProvider(ctx, options.rootUrl, control))
  } catch (error) {
    ctx.logger.warn(`[rune] bundled skill provider registration failed: ${String(error)}`)
    return () => {}
  }
}
