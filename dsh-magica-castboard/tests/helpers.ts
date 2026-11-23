/**
 * 测试夹具：临时目录、任务/issue/评论的最小合法记录。
 *
 * 记录形状跟随宿主内部契约（`src/host/model.ts`）：issue 的主键是 `id`，
 * 清单条目用 `checked`，评论带 `origin` / `role` / `authorType` / `threadId`。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { ChecklistItem, IssueRecord, TaskRecord, ThreadComment } from '../src/host/model.ts'

/** 建一个临时存储目录，并注册用例结束时的清理。 */
export function tempRoot(t: { after: (fn: () => void) => void }): string {
  const root = mkdtempSync(join(tmpdir(), 'castboard-b18-'))
  t.after(() => { rmSync(root, { recursive: true, force: true }) })
  return root
}

/** 一个未勾选的清单条目。 */
export function checklistItem(text: string, overrides: Partial<ChecklistItem> = {}): ChecklistItem {
  return { id: `k-${text.replace(/\s+/g, '-')}`, text, checked: false, ...overrides }
}

/** 最小合法任务记录。 */
export function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: 't-1',
    title: '补检测',
    detail: '把检测补上',
    workspaceId: 'ws-1',
    cwd: 'D:/repo',
    urgency: 'normal',
    status: 'todo',
    blocked: false,
    execution: { mode: 'queue' },
    createdAt: 1_000,
    updatedAt: 1_000,
    createdBy: { kind: 'user' },
    updatedBy: { kind: 'user' },
    executions: [],
    ...overrides,
  }
}

/** 最小合法 issue 记录（id 必须是 UUID 形状）。 */
export function issueRecord(overrides: Partial<IssueRecord> = {}): IssueRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    title: '待规划',
    detail: '正文',
    urgency: 'normal',
    status: 'pending',
    workspaceId: 'ws-1',
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  }
}

/** 一条最小合法评论。 */
export function threadComment(overrides: Partial<ThreadComment> = {}): ThreadComment {
  return {
    id: 'c-1',
    body: '收到',
    createdAt: 1_000,
    role: 'assigner',
    authorType: 'agent',
    origin: 'local',
    ...overrides,
  }
}
