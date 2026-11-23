/**
 * Where the tool set gets assembled: four groups of definitions end up in one registry.
 *
 * Only combination and narrowing live here. Each group receives a minimal dependency face, so no
 * group can reach storage or network capabilities it has no business touching.
 *
 * @module dsh-magica-castboard/host/tools
 */
import type { ToolDefinition as HostToolDefinition } from '@deepseek-ai/dsh-tools'

import type { CommentStore } from '../ledger/comment-store.ts'
import type { IssueStore } from '../ledger/issue-store.ts'
import type { LinkStore } from '../ledger/link-store.ts'
import type { TaskStore } from '../ledger/task-store.ts'
import type { ThreadService } from '../pipeline/thread.ts'
import type { IssueQueryFace } from '../pipeline/sdk-query.ts'
import { issueCommentTools, type CommentDeliveryFace, type IssueCommentToolDeps } from './issue-comment.ts'
import { issueTaskTools, type IssueTaskToolDeps, type UpstreamIssueComment } from './issue-task.ts'
import { buildIssueDispatchTools } from './issue-tools.ts'
import type { ToolDeps as DispatchToolDeps, ToolDefinition as DispatchToolDefinition } from './shared.ts'
import {
  castboardTools,
  type ExecutionFace,
  type ToolDeps as TaskToolDeps,
  type WorkspaceFace,
} from './task-tools.ts'

export * from './shared.ts'
export { castboardTools } from './task-tools.ts'
export { issueTaskTools } from './issue-task.ts'
export { buildIssueDispatchTools } from './issue-tools.ts'
export { issueCommentTools } from './issue-comment.ts'
export type { WorkspaceFace, ExecutionFace } from './task-tools.ts'
export type { IssueTaskToolDeps, UpstreamIssueComment } from './issue-task.ts'
export type { IssueCommentToolDeps, CommentDeliveryFace } from './issue-comment.ts'
export type { ToolDeps as DispatchToolDeps, ToolDefinition as DispatchToolDefinition } from './shared.ts'
export type { ToolDefinition as HostToolDefinition } from '@deepseek-ai/dsh-tools'

/**
 * Dependencies shared by all four tool groups. Fields are grouped by whose runtime fact they are;
 * the deliverer, for instance, is only ever used by the comment tool.
 */
export interface CastboardToolDeps {
  store: TaskStore
  workspaces: WorkspaceFace
  thread: ThreadService
  /** Session sweeps only; comments are recorded and delivered by ThreadService, never steered here. */
  execution?: ExecutionFace
  artifactUplink?: TaskToolDeps['artifactUplink']
  /** Absent = pinned models are shape-checked but never checked against registered routes. */
  modelProviders?: TaskToolDeps['modelProviders']
  issues: IssueStore
  comments: CommentStore
  links: LinkStore
  now: () => number
  resolveWorkspace: IssueTaskToolDeps['resolveWorkspace']
  issueRouted?: IssueTaskToolDeps['issueRouted']
  /** Issue-stage discussion, replayed into the comment stream when an issue becomes a task. */
  upstreamComments?: (issueId: string) => Promise<readonly UpstreamIssueComment[] | undefined>
  /** Absent = comments are stored and polling re-delivers them later. */
  deliverer?: CommentDeliveryFace
  remoteCreate?: DispatchToolDeps['remoteCreate']
  query?: IssueQueryFace
  remoteIssue?: DispatchToolDeps['remoteIssue']
  remoteComments?: DispatchToolDeps['remoteComments']
  /** Shared-library issue source dictionary (self-heal self/dsh + validate explicit codes). */
  sources?: NonNullable<DispatchToolDeps['sources']>
  /** Issue-target attachment sync for `castboard_issue_state`. */
  syncIssueAttachments?: DispatchToolDeps['syncIssueAttachments']
  /** Per-comment attachment sync for `castboard_issue_state`. */
  syncCommentAttachments?: DispatchToolDeps['syncCommentAttachments']
  /** Upload files attached to a newly written comment. */
  uploadCommentAttachments?: IssueCommentToolDeps['uploadCommentAttachments']
  /** Base directory for relative comment attachments. */
  attachmentCwd?: IssueCommentToolDeps['attachmentCwd']
  /** This instance's reply address, quoted in the dispatch guidance. */
  instance?: () => string
  inject?: DispatchToolDeps['inject']
  /** Session → project; absent = no project boundary check. */
  workspaceOf?: DispatchToolDeps['workspaceOf']
}

/** Narrow the shared dependencies down to what the task tools need. */
function taskToolDeps(deps: CastboardToolDeps): TaskToolDeps {
  return {
    store: deps.store,
    workspaces: deps.workspaces,
    thread: deps.thread,
    now: deps.now,
    ...(deps.execution === undefined ? {} : { execution: deps.execution }),
    ...(deps.artifactUplink === undefined ? {} : { artifactUplink: deps.artifactUplink }),
    ...(deps.modelProviders === undefined ? {} : { modelProviders: deps.modelProviders }),
  }
}

/** Issue → task conversion. */
function issueTaskToolDeps(deps: CastboardToolDeps): IssueTaskToolDeps {
  return {
    issues: deps.issues,
    store: deps.store,
    now: deps.now,
    resolveWorkspace: deps.resolveWorkspace,
    thread: deps.thread,
    links: deps.links,
    ...(deps.issueRouted === undefined ? {} : { issueRouted: deps.issueRouted }),
    ...(deps.upstreamComments === undefined ? {} : { comments: deps.upstreamComments }),
  }
}

/** Dispatch tools, where `tasks` is the short alias for the task ledger. */
function dispatchToolDeps(deps: CastboardToolDeps): DispatchToolDeps {
  return {
    tasks: deps.store,
    issues: deps.issues,
    comments: deps.comments,
    thread: deps.thread,
    links: deps.links,
    now: deps.now,
    ...(deps.remoteIssue === undefined ? {} : { remoteIssue: deps.remoteIssue }),
    ...(deps.remoteComments === undefined ? {} : { remoteComments: deps.remoteComments }),
    resolveWorkspace: async cwd => (await deps.resolveWorkspace(cwd))?.id,
    ...(deps.remoteCreate === undefined ? {} : { remoteCreate: deps.remoteCreate }),
    ...(deps.query === undefined ? {} : { query: deps.query }),
    ...(deps.instance === undefined ? {} : { instance: deps.instance }),
    ...(deps.inject === undefined ? {} : { inject: deps.inject }),
    ...(deps.sources === undefined ? {} : { sources: deps.sources }),
    ...(deps.syncIssueAttachments === undefined ? {} : { syncIssueAttachments: deps.syncIssueAttachments }),
    ...(deps.syncCommentAttachments === undefined ? {} : { syncCommentAttachments: deps.syncCommentAttachments }),
    ...(deps.workspaceOf === undefined ? {} : { workspaceOf: deps.workspaceOf }),
  }
}

/** Issue comment tool. */
function issueCommentToolDeps(deps: CastboardToolDeps): IssueCommentToolDeps {
  return {
    links: deps.links,
    tasks: deps.store,
    thread: deps.thread,
    ...(deps.deliverer === undefined ? {} : { deliverer: deps.deliverer }),
    ...(deps.uploadCommentAttachments === undefined
      ? {}
      : { uploadCommentAttachments: deps.uploadCommentAttachments }),
    ...(deps.attachmentCwd === undefined ? {} : { attachmentCwd: deps.attachmentCwd }),
  }
}

/**
 * The four groups merged into one list.
 *
 * The order is the order the model sees: task tools → single-issue conversion → dispatch
 * guidance / queries / batch creation → issue comments. Registration just consumes this array.
 *
 * @param deps - See {@link CastboardToolDeps}.
 */
export function buildTools(deps: CastboardToolDeps): readonly HostToolDefinition[] {
  const taskTools = castboardTools(taskToolDeps(deps))
  const conversionTools = issueTaskTools(issueTaskToolDeps(deps)) as unknown as HostToolDefinition[]
  const dispatchTools = buildIssueDispatchTools(dispatchToolDeps(deps))
  const commentTools = issueCommentTools(issueCommentToolDeps(deps)) as unknown as HostToolDefinition[]
  return [...taskTools, ...conversionTools, ...dispatchTools, ...commentTools]
}
