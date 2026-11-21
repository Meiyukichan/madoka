/**
 * 日志降噪：把指定 logger 名字的 `info` 输出关掉（`warn` / `error` 照旧）。
 *
 * 为什么能做：Cordis 的 logger 在**导出**时按 exporter 的 levels 过滤
 * （`vendor/cordis/src/logger.ts:155-158`）：
 *
 *   const targetLevel = exporter.levels?.[name] ?? exporter.levels?.default ?? logger.level ?? INFO
 *   if (targetLevel < level) continue
 *
 * 所以把某个名字的阈值提到 WARN(2)，它的 info 就不会输出 —— 插件本身照常运行。
 * 例：`[llm-deepseek-account] model listing from … loaded N model(s)` 是 info 级别
 * （`packages/llm/llm-deepseek/src/listing-cache.ts:122`），值得静音但不必关插件。
 */

/** Cordis 的 LoggerLevel 常量（WARN = 2）。 */
const WARN = 2

interface ExporterLike {
  levels?: Record<string, number>
}

interface LoggerServiceLike {
  exporters?: Map<number, ExporterLike>
}

/**
 * 静音若干 logger 名字的 info 输出。
 * @param ctx - 宿主 context（`logger` 是内置服务）。
 * @param names - 要静音的 logger 名字（与日志行里的 `[name]` 一致）。
 * @returns 还原函数（卸载时恢复原有阈值）。
 */
export function quietLoggers(ctx: { get: <T>(name: string) => T | undefined }, names: readonly string[]): () => void {
  if (names.length === 0) return () => {}
  let logger: LoggerServiceLike | undefined
  try {
    logger = ctx.get<LoggerServiceLike>('logger')
  } catch {
    return () => {}
  }
  const exporters = logger?.exporters
  if (!(exporters instanceof Map)) return () => {}

  const previous: Array<{ exporter: ExporterLike; levels: Record<string, number>; name: string; had: boolean; value: number | undefined }> = []
  for (const exporter of exporters.values()) {
    if (exporter?.levels === undefined) exporter.levels = {}
    for (const name of names) {
      const had = Object.hasOwn(exporter.levels, name)
      previous.push({ exporter, levels: exporter.levels, name, had, value: exporter.levels[name] })
      exporter.levels[name] = WARN
    }
  }

  return () => {
    for (const item of previous) {
      if (item.had) item.levels[item.name] = item.value as number
      else Reflect.deleteProperty(item.levels, item.name)
    }
  }
}
