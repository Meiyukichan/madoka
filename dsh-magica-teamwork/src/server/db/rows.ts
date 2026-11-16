/** node:sqlite 返回 `Record<string, SQLOutputValue>`，这里统一做一次显式转换 */
export function rows<T>(value: unknown): T[] {
  return value as unknown as T[]
}

export function row<T>(value: unknown): T | undefined {
  return value as unknown as T | undefined
}

export function first<T>(value: unknown): T {
  const r = row<T>(value)
  if (r === undefined) throw new Error('期望一行结果但查询为空（不应发生）')
  return r
}
