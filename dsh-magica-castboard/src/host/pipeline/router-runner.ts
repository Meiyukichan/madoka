/**
 * Assembly seam between pending issues and task cards: turns an issue into card-creation input and plugs the resident
 * router session into {@link IssueRouterService}'s `openSession`.
 *
 * ## The only mapping rule from issue to task
 *
 * Conversion only moves fields; missing fields are left to card creation and board settings:
 *
 * - `title` / `detail` / `workspaceId` / `urgency` map directly;
 * - `cwd` is passed along when present;
 * - `execution` is fixed to `queue` (the dispatcher starts a session once it reaches the backlog);
 * - model / permission / preset / checklist stay empty: the issue carries no such information, so the form and
 *   board defaults decide; nothing is invented here;
 * - `issueId` must be carried; it is the entire evidence that this card came from pending issues.
 *
 * ## Resident session
 *
 * The session itself is opened by {@link openWorkSession}: worklab directory, `read-only` sandbox, and a first turn
 * that only wakes it. The assembly layer computes the static guidance and passes it in (`routerRoutingSection`);
 * each turn's issue data is injected by the router service as named context.
 *
 * @module dsh-magica-castboard/host/pipeline/router-runner
 */
import type { CreateTaskBody, IssueRecord } from '../model.ts'
import {
  ISSUE_REFERENCES_SECTION,
  ISSUE_ROUTING_ORDER,
  ISSUE_ROUTING_SECTION,
  PLUGIN_NAME,
} from '../context/sections.ts'
import { ROUTER_IDLE_PROMPT } from '../context/texts.ts'
import type { ResolvedModel } from '../shared/default-model.ts'
import type { RouterLog, RouterSessionFace } from './router.ts'
import {
  openWorkSession,
  workSessionTtlMs,
  type WorkContext,
  type WorkSection,
} from './work-session.ts'

/** Environment variable naming the router's per-turn limit. */
export const ROUTER_TTL_ENV = 'DSH_CASTBOARD_ROUTER_TTL_MS'

export { ROUTER_IDLE_PROMPT }

/** Sandbox for the router session: a read-only workbench that touches no project. */
export const ROUTER_SANDBOX = 'read-only' as const

export function routerTtlMs(env: Record<string, string | undefined> = process.env): number {
  return workSessionTtlMs(ROUTER_TTL_ENV, env)
}

export function routerRoutingSection(guide: string): WorkSection {
  return { name: ISSUE_ROUTING_SECTION, text: guide, order: ISSUE_ROUTING_ORDER }
}

export function taskDraftFromIssue(issue: IssueRecord): CreateTaskBody {
  return {
    title: issue.title,
    detail: issue.detail,
    workspaceId: issue.workspaceId,
    ...(issue.cwd !== undefined ? { cwd: issue.cwd } : {}),
    urgency: issue.urgency,
    execution: { mode: 'queue' },
    issueId: issue.id,
  }
}

/**
 * Session opener shape accepted by `IssueRouterService`.
 */
export type RouterSessionOpener = (
  sessionId: string | undefined,
  onCompacted?: () => void,
) => Promise<RouterSessionFace>

/** Options for {@link createRouterSessionOpener}. */
export interface RouterRunnerOptions {
  readonly ctx: unknown
  /** Router session cwd (the worklab directory). */
  readonly cwd: string
  /** Static guidance sections; the assembly layer builds them with {@link routerRoutingSection}. */
  readonly sections?: readonly WorkSection[]
  /** Model route; it must already be resolved before being passed. */
  readonly model?: ResolvedModel
  readonly ttlMs?: number
  /** Plugin name that supplies the named context; defaults to this plugin. */
  readonly contextPlugin?: string
  readonly log?: RouterLog
}

/**
 * Build an `openSession` wrapping the resident worklab session; empty references inject no context.
 */
export function createRouterSessionOpener(options: RouterRunnerOptions): RouterSessionOpener {
  const sections = options.sections ?? []
  const ttlMs = options.ttlMs ?? routerTtlMs()
  const contextPlugin = options.contextPlugin ?? PLUGIN_NAME
  const log = options.log
  const referencesContext = (text: string): WorkContext => ({ name: ISSUE_REFERENCES_SECTION, text })

  return async (sessionId, onCompacted) => {
    const session = await openWorkSession(options.ctx, {
      label: 'router',
      cwd: options.cwd,
      title: 'DSH任务面板Router',
      sandbox: ROUTER_SANDBOX,
      ...(sessionId !== undefined ? { sessionId } : {}),
      idlePrompt: ROUTER_IDLE_PROMPT,
      ...(sections.length > 0 ? { sections } : {}),
      ...(options.model !== undefined ? { model: options.model } : {}),
      ttlMs,
      contextPlugin,
      quiescence: { timeoutMs: 600_000 },
      ...(onCompacted !== undefined ? { onCompacted } : {}),
    })
    log?.('info', 'router-session-handoff', `${session.id}（${session.resumed ? '续跑' : '新建'}）已交给 router`)
    return {
      id: session.id,
      resumed: session.resumed,
      run: (instruction, references) => session.run(
        instruction,
        references === '' ? [] : [referencesContext(references)],
      ),
      dispose: () => session.dispose(),
    }
  }
}
