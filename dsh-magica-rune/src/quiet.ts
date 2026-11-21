/**
 * 日志降噪：把指定 logger 名字的 `info` 输出**丢掉**（`warn` / `error` 照旧）。
 *
 * 为什么不能用 exporter.levels：Cordis 的级别是「详细度」而非「阈值」——
 *   ERROR=0 / INFO=1 / WARN=2 / DEBUG=3，判定是 `if (targetLevel < level) continue`
 * （`vendor/cordis/src/logger.ts:155-158`）。任何单一数值都做不到
 * 「只打印 warn+error、不打印 info」：2 会同时放过 info，1 会放过 info 丢掉 warn。
 *
 * 因此这里直接**包住 exporter 的 export 函数**：按 `message.name + message.type`
 * 丢弃指定名字的 info，其余原样透传；启动过程中后注册的 exporter 也自动被包（拦 Map.set）。
 *
 * 例：`[llm-deepseek-account] model listing from … loaded N model(s)` 是 info
 * （`packages/llm/llm-deepseek/src/listing-cache.ts:122`），值得静音但不必关插件。
 */

/** Cordis 的日志记录（只取用到的字段）。 */
interface MessageLike {
  name?: string
  type?: string
}

interface ExporterLike {
  export: (message: MessageLike) => void
}

interface LoggerServiceLike {
  exporters?: Map<number, ExporterLike>
}

/**
 * 静音若干 logger 名字的 info 输出。
 * @param ctx - 宿主 context（`logger` 是内置服务）。
 * @param names - 要静音的名字（与日志行里的 `[name]` 一致）。
 * @returns 还原函数。
 */
export function quietLoggers(logger: LoggerServiceLike | undefined, names: readonly string[]): () => void {
  if (names.length === 0) return () => {}
  const exporters = logger?.exporters
  if (!(exporters instanceof Map)) return () => {}

  const wanted = new Set(names)
  const originals = new Map<ExporterLike, (message: MessageLike) => void>()
  const shouldDrop = (message: MessageLike): boolean =>
    message.type === 'info' && typeof message.name === 'string' && wanted.has(message.name)

  const wrap = (exporter: ExporterLike | undefined): void => {
    if (exporter === undefined || exporter === null) return
    if (originals.has(exporter)) return
    if (typeof exporter.export !== 'function') return
    const original = exporter.export
    originals.set(exporter, original)
    exporter.export = function patched(message: MessageLike): void {
      if (shouldDrop(message)) return
      original.call(this, message)
    }
  }

  for (const exporter of exporters.values()) wrap(exporter)

  // 后注册的 exporter 也要包上：boot 是在启动过程中才注册 console exporter 的。
  const originalSet = exporters.set.bind(exporters)
  exporters.set = function patchedSet(key: number, value: ExporterLike): Map<number, ExporterLike> {
    wrap(value)
    return originalSet(key, value)
  }

  return () => {
    try { exporters.set = originalSet } catch { /* 忽略 */ }
    for (const [exporter, original] of originals) {
      try { exporter.export = original } catch { /* 忽略 */ }
    }
    originals.clear()
  }
}
