/**
 * 配置面：模板 / 设置 / 工作区指导 / Router / 验收策略 / 画像。
 *
 * 自定义文件的线格式在两代宿主之间换过字段名（落盘 `title`/`description`，
 * 0.1.2 线协议 `name`/`text`），这里在**边界**统一成面板自己的视图模型：
 * 读时两种都认，写时两种都带。面板与状态机只见一种形状。
 *
 * @module dsh-magica-castboard/client/data/endpoints/config
 */
import type { BoardSettings } from '../../../shared/wire.ts'
import { apiGet, apiPost } from '../api.ts'
import type { AcceptanceEntry, DiagnosticsView, RouterStrategyEntry, TemplateView, WorkspaceNoteEntry } from '../dto.ts'

interface RawTemplate {
  id: string
  name: string
  task: {
    title?: string
    detail?: string
    urgency?: string
    execution?: { mode?: string; cron?: string }
    model?: unknown
    permission?: string
    checklist?: readonly string[]
  }
  builtin?: boolean
  locales?: {
    zh?: { name?: string; task?: RawTemplate['task'] }
    en?: { name?: string; task?: RawTemplate['task'] }
  }
}

function templateModelOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'object' && value !== null) {
    const model = value as { provider?: unknown; model?: unknown }
    if (typeof model.provider === 'string' && typeof model.model === 'string') return `${model.provider}/${model.model}`
  }
  return undefined
}

function templateSpecOf(raw: RawTemplate['task']): TemplateView['spec'] {
  const mode = raw.execution?.mode
  return {
    ...(raw.title === undefined ? {} : { title: raw.title }),
    ...(raw.detail === undefined ? {} : { detail: raw.detail }),
    ...(raw.urgency === undefined ? {} : { urgency: raw.urgency as TemplateView['spec']['urgency'] }),
    ...(raw.permission === undefined ? {} : { permission: raw.permission }),
    ...(templateModelOf(raw.model) === undefined ? {} : { model: templateModelOf(raw.model) }),
    ...(mode === 'queue' || mode === 'scheduled'
      ? { execution: { mode, ...(raw.execution?.cron === undefined ? {} : { cron: raw.execution.cron }) } }
      : {}),
    ...(raw.checklist === undefined ? {} : { checklist: [...raw.checklist] }),
  }
}

function templateViewOf(raw: RawTemplate): TemplateView {
  const zhName = raw.locales?.zh?.name ?? raw.name
  const enName = raw.locales?.en?.name ?? raw.name
  return {
    id: raw.id,
    name: { zh: zhName, en: enName },
    spec: templateSpecOf(raw.task),
    ...(raw.builtin === undefined ? {} : { builtin: raw.builtin }),
  }
}

async function readTemplates(): Promise<{ templates: readonly TemplateView[] }> {
  const result = await apiGet<{ templates: readonly RawTemplate[] }>('/templates')
  return { templates: result.templates.map(templateViewOf) }
}

export function apiTemplates(): Promise<{ templates: readonly TemplateView[] }> {
  return readTemplates()
}

export async function apiUpsertTemplate(input: { id: string; name: { zh: string; en: string }; description?: { zh: string; en: string }; spec: TemplateView['spec'] }): Promise<{ templates: readonly TemplateView[] }> {
  await apiPost('/templates', {
    id: input.id,
    name: input.name.zh.trim() === '' ? input.name.en : input.name.zh,
    task: input.spec,
  })
  return readTemplates()
}

export function apiDeleteTemplate(id: string): Promise<{ deleted: boolean }> {
  return apiPost('/templates/delete', { id })
}

export function apiSettings(): Promise<BoardSettings> {
  return apiGet('/settings')
}

export function apiUpdateSettings(settings: BoardSettings): Promise<BoardSettings> {
  return apiPost('/settings/update', settings)
}

// ─── 工作区指导 ──────────────────────────────────────────────────────

/** 宿主条目的两种历史形状（`{workspaceId,description}` / `{id,note}`）。 */
interface RawWorkspaceNote {
  workspaceId?: string
  id?: string
  name?: string
  path?: string
  description?: string
  note?: string
}

function workspaceNote(raw: RawWorkspaceNote, fallbackId?: string): WorkspaceNoteEntry | undefined {
  const workspaceId = raw.workspaceId ?? raw.id ?? fallbackId ?? ''
  if (workspaceId === '') return undefined
  return {
    workspaceId,
    ...(raw.name === undefined ? {} : { name: raw.name }),
    ...(raw.path === undefined ? {} : { path: raw.path }),
    ...(raw.description === undefined && raw.note === undefined ? {} : { description: raw.description ?? raw.note ?? '' }),
  }
}

function workspaceNotes(value: { items?: readonly RawWorkspaceNote[]; workspaces?: Readonly<Record<string, string>> }): readonly WorkspaceNoteEntry[] {
  if (value.items !== undefined) {
    return value.items.map(item => workspaceNote(item)).filter((item): item is WorkspaceNoteEntry => item !== undefined)
  }
  // 兼容「id → 说明」的字典形状。
  return Object.entries(value.workspaces ?? {}).flatMap(([id, note]) => {
    const entry = workspaceNote({ workspaceId: id, description: note })
    return entry === undefined ? [] : [entry]
  })
}

export async function apiWorkspaceNotes(): Promise<{ items: readonly WorkspaceNoteEntry[] }> {
  const value = await apiGet<{ items?: readonly RawWorkspaceNote[]; workspaces?: Readonly<Record<string, string>> }>('/workspaces-custom')
  return { items: workspaceNotes(value) }
}

export async function apiUpdateWorkspaceNotes(items: readonly WorkspaceNoteEntry[]): Promise<{ items: readonly WorkspaceNoteEntry[] }> {
  const payload = items.map(item => ({
    workspaceId: item.workspaceId,
    ...(item.name === undefined ? {} : { name: item.name }),
    ...(item.path === undefined ? {} : { path: item.path }),
    description: item.description ?? '',
    note: item.description ?? '',
  }))
  const value = await apiPost<{ items?: readonly RawWorkspaceNote[]; workspaces?: Readonly<Record<string, string>> }>('/workspaces-custom/update', {
    items: payload,
    workspaces: Object.fromEntries(payload.map(item => [item.workspaceId, item.description])),
  })
  return { items: workspaceNotes(value) }
}

// ─── Router 派活策略 ────────────────────────────────────────────────

interface RawRouterStrategy {
  id?: string
  title?: string
  name?: string
  description?: string
  text?: string
}

function routerStrategy(raw: RawRouterStrategy): RouterStrategyEntry | undefined {
  const name = (raw.name ?? raw.title ?? '').trim()
  if (name === '') return undefined
  return {
    ...(raw.id === undefined ? {} : { id: raw.id }),
    name,
    text: raw.text ?? raw.description ?? '',
  }
}

function routerStrategies(value: { items?: readonly RawRouterStrategy[]; strategies?: readonly RawRouterStrategy[] }): readonly RouterStrategyEntry[] {
  const list = value.items ?? value.strategies ?? []
  return list.map(item => routerStrategy(item)).filter((item): item is RouterStrategyEntry => item !== undefined)
}

export async function apiRouterStrategies(): Promise<{ items: readonly RouterStrategyEntry[] }> {
  const value = await apiGet<{ items?: readonly RawRouterStrategy[]; strategies?: readonly RawRouterStrategy[] }>('/strategy-custom')
  return { items: routerStrategies(value) }
}

export async function apiUpdateRouterStrategies(items: readonly RouterStrategyEntry[]): Promise<{ items: readonly RouterStrategyEntry[] }> {
  const payload = items.map(item => ({
    ...(item.id === undefined ? {} : { id: item.id }),
    name: item.name,
    text: item.text,
    title: item.name,
    description: item.text,
  }))
  const value = await apiPost<{ items?: readonly RawRouterStrategy[]; strategies?: readonly RawRouterStrategy[] }>('/strategy-custom/update', { items: payload })
  return { items: routerStrategies(value) }
}

// ─── 验收策略 ───────────────────────────────────────────────────────

/** 宿主策略行的原始形状（落盘字段是 `description`；旧线协议里叫 `text`）。 */
interface RawAcceptanceEntry {
  id?: string
  type: 'issue' | 'close'
  title: string
  description?: string
  text?: string
}

function acceptanceEntry(raw: RawAcceptanceEntry): AcceptanceEntry {
  return { id: raw.id ?? '', type: raw.type, title: raw.title, description: raw.description ?? raw.text ?? '' }
}

export async function apiAcceptanceStrategies(): Promise<{ strategies: readonly AcceptanceEntry[] }> {
  const value = await apiGet<{ strategies: readonly RawAcceptanceEntry[] }>('/acceptance-strategy')
  return { strategies: value.strategies.map(acceptanceEntry) }
}

export async function apiUpdateAcceptanceStrategies(strategies: readonly AcceptanceEntry[]): Promise<{ strategies: readonly AcceptanceEntry[] }> {
  const payload = strategies.map(entry => ({
    id: entry.id,
    type: entry.type,
    title: entry.title,
    description: entry.description,
    text: entry.description,
  }))
  const value = await apiPost<{ strategies: readonly RawAcceptanceEntry[] }>('/acceptance-strategy/update', { strategies: payload })
  return { strategies: value.strategies.map(acceptanceEntry) }
}

export function apiRefreshPortraits(): Promise<{ reset: number }> {
  return apiPost('/portrait/refresh')
}

export function apiDiagnostics(): Promise<DiagnosticsView> {
  return apiGet('/diagnostics')
}
