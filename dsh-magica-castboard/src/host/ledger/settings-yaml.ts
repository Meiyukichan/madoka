/**
 * `castboard.settings.yaml` codec — a deliberately tiny YAML subset.
 *
 * The board settings object is a flat map of five scalars, so a full YAML parser
 * would be a dependency bought for nothing. This module reads and writes exactly:
 *
 * - one `key: value` pair per line, keys `[A-Za-z][A-Za-z0-9_-]*`;
 * - blank lines, `#` comments (whole-line, or trailing after whitespace), and the
 *   `---` / `...` document markers, which are ignored;
 * - scalars: `true` / `false`, integers, decimals, `null` / `~` (meaning "unset"),
 *   `"double"` and `'single'` quoted strings;
 * - no indentation, no nesting, no lists, no anchors, no multi-line values — a nested
 *   document is rejected with a readable error instead of being half-understood.
 *
 * Unknown keys are kept by the parser and dropped by `asBoardSettings`, so a newer
 * version's file still loads here. Values are untyped on purpose: range and enum
 * validation stays in `rules.ts`, one place, shared with the HTTP write path.
 *
 * @module dsh-magica-castboard/host/ledger/settings-yaml
 */
import type { BoardSettings } from '../model.ts'

/** Emission order: stable diffs across saves, and roughly "most interesting first". */
const FIELD_ORDER = [
  'defaultPermission',
  'maxConcurrent',
  'autoRoute',
  'portraitRunOnStart',
  'commentsEnabled',
  'commentPollMs',
] as const satisfies readonly (keyof BoardSettings)[]

const HEADER = [
  '# castboard 看板设置。面板「保存设置」会整份覆盖这个文件；也可以手改，下一次轮询生效。',
  '# 只支持扁平的 key: value（不支持缩进 / 嵌套 / 列表）；删除某个键 = 回退出厂默认值。',
  '#   maxConcurrent      并发执行上限，整数 1..20（出厂 4）',
  '#   autoRoute          自动路由待规划 issue，true / false',
  '#   portraitRunOnStart 启动时立即补跑一次项目肖像，true / false（出厂 false）',
  '#   commentsEnabled    评论拉取，true / false',
  '#   commentPollMs      评论轮询间隔毫秒，1000..3600000（出厂 5000）',
  '#   defaultPermission  新卡默认权限：workspace-write | read-only | danger-full-access',
].join('\n')

const PAIR = /^([A-Za-z][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/

const BARE_STRING = /^[A-Za-z0-9_.@/+-]+$/

/** Parse the flat document into raw (unvalidated) keys. Throws on structure it cannot read. */
export function parseSettingsYaml(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---' || trimmed === '...') continue
    if (raw !== raw.trimStart()) {
      throw new Error(`第 ${String(index + 1)} 行：不支持缩进（只支持扁平 key: value）`)
    }
    const match = PAIR.exec(trimmed)
    if (match === null) {
      throw new Error(`第 ${String(index + 1)} 行：不是 key: value —— ${trimmed}`)
    }
    const key = match[1] ?? ''
    const rest = match[2]
    if (rest === undefined || rest.trim() === '') {
      throw new Error(`第 ${String(index + 1)} 行：${key} 缺少值`)
    }
    let value: unknown
    try {
      value = parseScalar(rest)
    } catch (error) {
      throw new Error(`第 ${String(index + 1)} 行：${errorText(error)}`)
    }
    // `key: null` / `key: ~` means "unset": drop it rather than store a null.
    if (value !== null) out[key] = value
  }
  return out
}

/** Serialize only the explicitly set fields, in a fixed order, preceded by the format hint. */
export function serializeSettingsYaml(value: BoardSettings): string {
  const lines: string[] = [HEADER]
  for (const key of FIELD_ORDER) {
    const field = value[key]
    if (field === undefined) continue
    lines.push(`${key}: ${formatScalar(field)}`)
  }
  return `${lines.join('\n')}\n`
}

function parseScalar(text: string): unknown {
  const value = text.trim()
  const quote = value[0]
  if (quote === '"' || quote === "'") {
    const end = closingQuote(value, quote)
    if (end < 0) throw new Error(`字符串缺少收尾的 ${quote}`)
    const body = value.slice(1, end)
    const rest = value.slice(end + 1).trim()
    if (rest !== '' && !rest.startsWith('#')) throw new Error(`引号后有多余内容：${rest}`)
    return quote === '"' ? unescapeDouble(body) : body.replaceAll("''", "'")
  }
  const comment = value.indexOf(' #')
  const scalar = (comment < 0 ? value : value.slice(0, comment)).trim()
  if (scalar === 'null' || scalar === '~') return null
  if (/^(true|false)$/i.test(scalar)) return scalar.toLowerCase() === 'true'
  if (/^-?\d+$/.test(scalar)) return Number(scalar)
  if (/^-?\d+\.\d+$/.test(scalar)) return Number(scalar)
  return scalar
}

function closingQuote(value: string, quote: string): number {
  for (let index = 1; index < value.length; index += 1) {
    const char = value[index]
    if (quote === '"' && char === '\\') {
      index += 1
      continue
    }
    if (char === quote) {
      // A doubled single quote is an escaped quote, not the end of the string.
      if (quote === "'" && value[index + 1] === "'") {
        index += 1
        continue
      }
      return index
    }
  }
  return -1
}

function unescapeDouble(body: string): string {
  return body.replace(/\\(["\\])/g, '$1')
}

function formatScalar(field: string | number | boolean): string {
  if (typeof field !== 'string') return String(field)
  if (BARE_STRING.test(field)) return field
  return `"${field.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
