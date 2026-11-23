import { test } from 'node:test'
import assert from 'node:assert/strict'

import { directRoute, type DirectRouteDeps } from '../src/host/pipeline/direct.ts'
import { IssueStore } from '../src/host/ledger/issue-store.ts'
import { tempRoot } from './helpers.ts'

test('direct 校验失败：assignee 评论 + assigneeMeta 回写', async t => {
  const issues = new IssueStore({ dir: tempRoot(t), now: () => 1_000 })
  const issue = await issues.create({
    title: '输出 miku',
    detail: '直接输出 miku',
    workspaceId: '',
    urgency: 'direct',
  })

  const comments: Array<{ body: string; role?: string | null }> = []
  let abandonedMeta: Record<string, unknown> | undefined
  const deps = {
    issues,
    // The rejection path never touches the task store.
    store: {},
    now: () => 1_000,
    resolveWorkspace: async () => undefined,
    thread: {
      add: async (_issueId: string, draft: { body: string; role?: string | null }) => {
        comments.push(draft)
        return undefined
      },
    },
    issueAbandon: async (_issueId: string, meta?: Record<string, unknown>) => {
      abandonedMeta = meta
    },
    ensureDir: async () => true,
  } as unknown as DirectRouteDeps

  const outcome = await directRoute(deps, issue.id)
  assert.equal(outcome.kind, 'rejected')
  assert.equal(comments.length, 1)
  assert.equal(comments[0]?.role, 'assignee')
  assert.match(comments[0]?.body ?? '', /cwd/)

  const local = await issues.get(issue.id)
  assert.equal(local?.status, 'abandoned')
  const validation = local?.assigneeMeta?.directValidation as
    | { errors?: readonly string[]; message?: string }
    | undefined
  assert.ok(validation !== undefined)
  assert.ok((validation.errors ?? []).length > 0)
  assert.match(validation.message ?? '', /cwd/)

  assert.ok(abandonedMeta !== undefined)
  assert.deepEqual(abandonedMeta?.directValidation, validation)
})
