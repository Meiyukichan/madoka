/**
 * On-disk layout. Everything sits under `$DSH_HOME/storages/castboard/`; TaskStore migrates
 * a single-file ledger once when it loads the storage, so only the current layout is
 * described here.
 *
 * @module dsh-magica-castboard/host/paths
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome(): string {
  const fromEnv = process.env.DSH_HOME
  return fromEnv !== undefined && fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

export function storageRoot(): string {
  return join(dshHome(), 'storages', 'castboard')
}

export interface CastboardPaths {
  root: string
  lease: string
  taskIndex: string
  /** Board settings, kept out of the ledger so hand edits never race a task write. */
  settingsFile: string
  taskDir: string
  issueIndex: string
  issueDir: string
  linkFile: string
  commentDir: string
  commentCursor: string
  publishCursor: string
}

/** Compute all paths at once. Tests can pass a different root. */
export function castboardPaths(root = storageRoot()): CastboardPaths {
  return {
    root,
    lease: join(root, 'castboard.pid'),
    taskIndex: join(root, 'castboard-task.json'),
    settingsFile: join(root, 'castboard.settings.yaml'),
    taskDir: join(root, 'tasks'),
    issueIndex: join(root, 'castboard-issue.json'),
    issueDir: join(root, 'issues'),
    linkFile: join(root, 'castboard-link.json'),
    commentDir: join(root, 'comments'),
    commentCursor: join(root, 'comment-cursor.json'),
    publishCursor: join(root, 'comment-publish-cursor.json'),
  }
}

export function taskFile(paths: CastboardPaths, id: string): string {
  return join(paths.taskDir, `${id}.json`)
}

export function issueFile(paths: CastboardPaths, id: string): string {
  return join(paths.issueDir, `${id}.json`)
}

/** One JSONL stream per anchor; the anchor is an issue id or a task id. */
export function commentFile(paths: CastboardPaths, anchorId: string): string {
  return join(paths.commentDir, `${anchorId}.jsonl`)
}

// Allow-list, and a security boundary: these ids get concatenated into filenames.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_PATTERN.test(id)
}
