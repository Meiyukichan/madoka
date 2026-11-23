/**
 * Task templates, merging built-ins shipped with the package with user templates.
 *
 * Built-ins live in `resources/builtin-templates.json` and are read-only; user templates
 * live in `$DSH_HOME/storages/castboard/task-templates.json` and can be added, edited, and
 * removed. Every `list()` merges them with the user version winning on a shared id, so
 * deleting a customization restores the built-in content.
 *
 * Built-ins carry `locales` with both languages while the top-level `name` / `task` keep a
 * Chinese fallback for consumers that do not know about locales. User templates are never
 * translated.
 *
 * @module dsh-magica-castboard/host/ledger/template-store
 */
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import type { TaskTemplate, TaskTemplateSpec, TemplateLocales } from '../model.ts'
import { eventLog } from '../shared/event-log.ts'

export type BuiltinTemplate = TaskTemplate & {
  readonly builtin: true
  readonly locales: TemplateLocales
}

interface BuiltinResource {
  readonly version?: number
  readonly templates: Readonly<Record<string, TemplateLocales>>
}

// Source runs from `src/host/ledger/`, the bundle from `lib/index.js`, so both depths are
// tried; if neither reads, the plugin still starts, just without built-ins.
const BUILTIN_RESOURCES: readonly URL[] = [
  new URL('../../../resources/builtin-templates.json', import.meta.url),
  new URL('../resources/builtin-templates.json', import.meta.url),
]

function newTemplateId(): string {
  return `tpl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function loadBuiltin(): Promise<BuiltinTemplate[]> {
  let lastError: unknown
  for (const resource of BUILTIN_RESOURCES) {
    let raw: string
    try {
      raw = await readFile(resource, 'utf8')
    } catch (error) {
      lastError = error
      continue
    }
    try {
      const parsed = JSON.parse(raw) as BuiltinResource
      const out: BuiltinTemplate[] = []
      for (const [id, locales] of Object.entries(parsed.templates ?? {})) {
        const zh = locales?.zh
        if (zh === undefined || typeof zh.name !== 'string' || !isRecord(zh.task)) continue
        out.push({ id, name: zh.name, task: zh.task as TaskTemplateSpec, locales, builtin: true })
      }
      return out
    } catch (error) {
      lastError = error
    }
  }
  eventLog('error', 'builtin-templates-unavailable', errorText(lastError))
  return []
}

// Invalid entries are simply not templates yet; they are filtered out, not reported.
function pickTemplates(raw: unknown): TaskTemplate[] {
  if (!isRecord(raw)) return []
  const templates = raw.templates
  if (!Array.isArray(templates)) return []
  return templates.filter((entry): entry is TaskTemplate =>
    isRecord(entry)
    && typeof entry.id === 'string'
    && typeof entry.name === 'string'
    && isRecord(entry.task))
}

export class TemplateStore {
  private readonly file: string
  private readonly previousFile: string | undefined
  private userTemplates: TaskTemplate[] | undefined
  private builtinTemplates: BuiltinTemplate[] | undefined

  // The source file is imported once when the target is absent; omitting it skips that.
  constructor(file: string, previousFile?: string) {
    this.file = file
    this.previousFile = previousFile
  }

  private async ensure(): Promise<void> {
    if (this.userTemplates !== undefined && this.builtinTemplates !== undefined) return
    this.builtinTemplates ??= await loadBuiltin()
    if (this.userTemplates !== undefined) return
    let parsed: TaskTemplate[] = []
    let readFromTarget = false
    try {
      parsed = pickTemplates(JSON.parse(await readFile(this.file, 'utf8')))
      readFromTarget = true
    } catch {
      /* Missing or corrupt is the same as no user templates */
    }
    if (!readFromTarget) parsed = await this.migratePrevious()
    this.userTemplates = parsed
  }

  private async migratePrevious(): Promise<TaskTemplate[]> {
    if (this.previousFile === undefined) return []
    try {
      const parsed = pickTemplates(JSON.parse(await readFile(this.previousFile, 'utf8')))
      if (parsed.length === 0) return []
      await this.persist(parsed)
      eventLog('info', 'templates-migrated', `${parsed.length} 条来自 ${this.previousFile}`)
      return parsed
    } catch {
      return []
    }
  }

  // Temp file + fsync + rename: a half-written template list would otherwise be silently
  // read as "no user templates" on the next start.
  private async persist(templates: TaskTemplate[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const temp = join(dirname(this.file), `.${Math.random().toString(36).slice(2)}.tmp`)
    const handle = await open(temp, 'w')
    try {
      await handle.writeFile(JSON.stringify({ templates }, null, 2), 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temp, this.file)
  }

  /** User templates first, then built-ins that are not shadowed by an id. */
  async list(): Promise<TaskTemplate[]> {
    await this.ensure()
    const user = this.userTemplates ?? []
    const taken = new Set(user.map(template => template.id))
    return [
      ...user.slice(),
      ...(this.builtinTemplates ?? []).filter(template => !taken.has(template.id)),
    ]
  }

  /**
   * Create or replace a user template.
   *
   * Reusing a built-in id is allowed and shadows the built-in; deleting the user template
   * restores it.
   */
  async upsert(input: { id?: string; name: string; task: TaskTemplateSpec }): Promise<TaskTemplate> {
    await this.ensure()
    const templates = this.userTemplates ?? []
    const name = input.name.trim()
    if (name.length === 0 || name.length > 60) throw new Error('模板名必须 1..60 字符')
    const now = Date.now()
    const existing = input.id !== undefined
      ? templates.find(template => template.id === input.id)
      : undefined
    const stored: TaskTemplate = existing !== undefined
      ? { ...existing, name, task: input.task, updatedAt: now }
      : { id: input.id ?? newTemplateId(), name, task: input.task, createdAt: now, updatedAt: now }
    const index = existing !== undefined ? templates.indexOf(existing) : -1
    if (index >= 0) templates[index] = stored
    else templates.push(stored)
    await this.persist(templates)
    this.userTemplates = templates
    return stored
  }

  /**
   * Delete a user template.
   *
   * Built-ins cannot be removed because they are not in the user file. Once the shadowing
   * user template is gone, the built-in version is listed again automatically.
   */
  async remove(id: string): Promise<boolean> {
    await this.ensure()
    const templates = this.userTemplates ?? []
    const index = templates.findIndex(template => template.id === id)
    if (index < 0) return false
    templates.splice(index, 1)
    await this.persist(templates)
    this.userTemplates = templates
    return true
  }

  async isBuiltin(id: string): Promise<boolean> {
    await this.ensure()
    return (this.builtinTemplates ?? []).some(template => template.id === id)
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
