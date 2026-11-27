import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { IssueRecord, IssueSummary } from '../src/host/model.ts'
import type { IssueStore } from '../src/host/ledger/issue-store.ts'
import { platformRuntimeTool, RUNTIME_COMMAND_ARGUMENTS_SCHEMA } from '../src/host/runtime-contract.ts'
import {
  createShellRuntimeExecutor,
  createToolArgsValidator,
  parseRuntimeCommand,
  runtimeCommandComment,
  type RuntimeCommandRequest,
  type RuntimeCommandResult,
  type RuntimeShell,
} from '../src/host/pipeline/runtime-command.ts'
import {
  RuntimeCommandWorker,
  type RuntimeWorkerDeps,
} from '../src/host/pipeline/runtime-worker.ts'

const baseRecord = (overrides: Partial<IssueRecord> = {}): IssueRecord => ({
  id: 'issue-1',
  title: 'runtime test',
  detail: '',
  urgency: 'runtime',
  status: 'accepted',
  assigner: 'user-1',
  assignee: 'user-1',
  assigneeInstance: 'host:3080',
  cwd: '/tmp/work',
  permission: 'workspace-write',
  workspaceId: '',
  createdAt: 1,
  updatedAt: 1,
  assignerMeta: {
    runtime: {
      arguments: { command: 'echo hi', description: 'say hi', timeoutMs: 30_000 },
    },
  },
  ...overrides,
})

const summaryOf = (record: IssueRecord): IssueSummary => ({
  id: record.id,
  title: record.title,
  urgency: record.urgency,
  status: record.status,
  assigner: record.assigner,
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  workspaceId: record.workspaceId,
})

class FakeIssues {
  readonly records = new Map<string, IssueRecord>()

  constructor(records: readonly IssueRecord[]) {
    for (const record of records) this.records.set(record.id, structuredClone(record))
  }

  summaries(): readonly IssueSummary[] {
    return [...this.records.values()].map(summaryOf)
  }

  async get(id: string): Promise<IssueRecord | undefined> {
    const record = this.records.get(id)
    return record === undefined ? undefined : structuredClone(record)
  }

  async update(id: string, mutator: (record: IssueRecord) => boolean | void): Promise<IssueRecord | undefined> {
    const current = this.records.get(id)
    if (current === undefined) return undefined
    const next = structuredClone(current)
    if (mutator(next) === false) return undefined
    next.updatedAt = 2
    this.records.set(id, next)
    return structuredClone(next)
  }

  asStore(): IssueStore {
    return this as unknown as IssueStore
  }
}

const okResult: RuntimeCommandResult = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  stdout: 'hi\n',
  stderr: '',
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 12,
}

const shellRun = {
  exitCode: 0,
  signal: null,
  timedOut: false,
  aborted: false,
  stdout: { text: 'hi\n', truncated: false },
  stderr: { text: '', truncated: false },
}

function bashRequest(overrides: Partial<RuntimeCommandRequest> = {}): RuntimeCommandRequest {
  return {
    arguments: { command: 'pwd', description: 'print cwd' },
    tool: platformRuntimeTool(),
    command: 'pwd',
    description: 'print cwd',
    workdir: '/tmp/work',
    timeoutMs: 1_000,
    permission: 'workspace-write',
    ...overrides,
  }
}

function workerFixture(record: IssueRecord, execute: RuntimeWorkerDeps['execute'], resolveWorkspace: RuntimeWorkerDeps['resolveWorkspace'] = async () => ({ id: 'ws-1', path: '/tmp/work' })): {
  issues: FakeIssues
  comments: Array<{ id: string; body: string }>
  finalized: Array<{ issueId: string; status: string; assigneeMeta: Record<string, unknown> }>
  published: Array<{ issueId: string; commentId: string; body: string }>
  worker: RuntimeCommandWorker
} {
  const issues = new FakeIssues([record])
  const comments: Array<{ id: string; body: string }> = []
  const finalized: Array<{ issueId: string; status: string; assigneeMeta: Record<string, unknown> }> = []
  const published: Array<{ issueId: string; commentId: string; body: string }> = []
  const worker = new RuntimeCommandWorker({
    issues: issues.asStore(),
    instance: () => 'host:3080',
    execute,
    resolveWorkspace,
    validateToolArgs: () => undefined,
    thread: {
      addSystem: async (_anchorId, draft) => {
        comments.push({ id: draft.id ?? '', body: draft.body })
        return draft
      },
    },
    publish: async input => { published.push(input) },
    finalize: async (issueId, input) => { finalized.push({ issueId, ...input }) },
    now: () => 123,
  })
  return { issues, comments, finalized, published, worker }
}

test('parseRuntimeCommand：合法 bash payload 使用 issue.cwd 与默认值', () => {
  const parsed = parseRuntimeCommand({
    cwd: '/tmp/work',
    permission: 'workspace-write',
    assignerMeta: {
      runtime: { arguments: { command: 'pwd', description: 'print cwd' } },
    },
  })
  assert.equal(parsed.ok, true)
  if (!parsed.ok) return
  assert.equal(parsed.request.command, 'pwd')
  assert.equal(parsed.request.workdir, '/tmp/work')
  assert.equal(parsed.request.timeoutMs, 120_000)
  assert.equal(parsed.request.permission, 'workspace-write')
})

test('parseRuntimeCommand：非法 tool / command / 参数 / timeout / workdir 都拒绝', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['missing runtime', {}],
    ['missing command', { runtime: { arguments: { description: 'x' } } }],
    ['unknown argument', { runtime: { arguments: { command: 'pwd', description: 'cwd', run_in_background: true } } }],
    ['bad timeout', { runtime: { arguments: { command: 'pwd', description: 'cwd', timeoutMs: 10 } } }],
    ['relative workdir', { runtime: { arguments: { command: 'pwd', description: 'cwd', workdir: 'relative' } } }],
  ]
  for (const [name, assignerMeta] of cases) {
    const parsed = parseRuntimeCommand({ cwd: '/tmp/work', permission: 'workspace-write', assignerMeta })
    assert.equal(parsed.ok, false, name)
  }
})

test('parseRuntimeCommand：runtime 必须显式 permission', () => {
  const parsed = parseRuntimeCommand({
    cwd: '/tmp/work',
    assignerMeta: { runtime: { arguments: { command: 'pwd', description: 'cwd' } } },
  })
  assert.equal(parsed.ok, false)
  if (!parsed.ok) assert.match(parsed.reason, /missing permission/)
})

test('createToolArgsValidator：按 DSH 参数 schema 校验 required / 类型', () => {
  const validate = createToolArgsValidator(tool => tool === 'bash'
    ? {
        type: 'object',
        properties: {
          command: { type: 'string' },
          description: { type: 'string' },
          timeoutMs: { type: 'number' },
        },
        required: ['command', 'description'],
      }
    : undefined)
  assert.equal(validate('bash', { command: 'pwd', description: 'print cwd' }), undefined)
  assert.match(validate('bash', { command: 'pwd' }) ?? '', /description/)
  assert.match(validate('bash', { command: 'pwd', description: 7 }) ?? '', /description/)
  assert.match(validate('missing', {}) ?? '', /schema is unavailable/)
})

test('createToolArgsValidator：全局 registry 看不到 pwsh 时用命令 schema 兜底', () => {
  const validate = createToolArgsValidator(
    () => undefined,
    tool => tool === 'pwsh' ? RUNTIME_COMMAND_ARGUMENTS_SCHEMA : undefined,
  )
  assert.equal(validate('pwsh', { command: 'Get-Location', description: 'print cwd' }), undefined)
  assert.match(validate('pwsh', { command: 'Get-Location' }) ?? '', /description/)
  assert.match(validate('pwsh', { command: '', description: 'x' }) ?? '', /command/)
  assert.match(validate('missing', {}) ?? '', /schema is unavailable/)
})

test('createShellRuntimeExecutor：受限 permission 在无 sandbox 时 fail closed', async () => {
  const shell: RuntimeShell = {
    sandboxMode: undefined,
    resolve: () => ({}),
    execute: async () => ({ result: async () => shellRun }),
  }
  await assert.rejects(
    createShellRuntimeExecutor(shell)(bashRequest()),
    /no sandbox/,
  )
})

test('createShellRuntimeExecutor：传入 workdir / permission / stdout 上限并映射结果', async () => {
  const calls: unknown[] = []
  const shell: RuntimeShell = {
    sandboxMode: 'workspace-write',
    resolve: request => { calls.push(request); return { request } },
    execute: async () => ({ result: async () => shellRun }),
  }
  const result = await createShellRuntimeExecutor(shell)(bashRequest({ timeoutMs: 30_000 }))
  assert.equal(calls.length, 1)
  const request = calls[0] as { workdir: string; sandboxPolicy: { mode: string; workspaceRoot: string } }
  assert.equal(request.workdir, '/tmp/work')
  assert.deepEqual(request.sandboxPolicy, { mode: 'workspace-write', workspaceRoot: '/tmp/work' })
  assert.equal(result.stdout, 'hi\n')
  assert.equal(result.exitCode, 0)
})

test('createShellRuntimeExecutor：请求的 permission 超过沙箱上限时拒绝执行', async () => {
  const shell: RuntimeShell = {
    sandboxMode: 'workspace-write',
    resolve: () => ({}),
    execute: async () => ({ result: async () => shellRun }),
  }
  await assert.rejects(
    createShellRuntimeExecutor(shell)(bashRequest({ permission: 'danger-full-access' })),
    /exceeds the instance sandbox maximum/,
  )
})

test('runtimeCommandComment：包含命令、exit code、stdout / stderr', () => {
  const body = runtimeCommandComment(bashRequest({
    arguments: { command: 'echo hi', description: 'say hi' },
    command: 'echo hi',
    description: 'say hi',
  }), okResult)
  assert.match(body, /runtime (bash|pwsh)/)
  assert.match(body, /\$ echo hi/)
  assert.match(body, /exit code: 0/)
  assert.match(body, /hi/)
})

test('platformRuntimeTool：Windows 用 pwsh，Linux/macOS 用 bash', () => {
  assert.equal(platformRuntimeTool('win32'), 'pwsh')
  assert.equal(platformRuntimeTool('linux'), 'bash')
  assert.equal(platformRuntimeTool('darwin'), 'bash')
})

test('RuntimeCommandWorker：tick 不等待命令完成', async () => {
  let release: (() => void) | undefined
  let started = 0
  const fixture = workerFixture(baseRecord(), async () => new Promise<RuntimeCommandResult>(resolve => {
    started += 1
    release = () => resolve(okResult)
  }))
  await fixture.worker.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(started, 1)
  assert.equal(fixture.issues.records.get('issue-1')?.status, 'routing')
  release?.()
  await fixture.worker.settled()
  assert.equal(fixture.issues.records.get('issue-1')?.status, 'success')
})

test('RuntimeCommandWorker：dispose 会 abort 正在执行的命令', async () => {
  let signal: AbortSignal | undefined
  const fixture = workerFixture(baseRecord(), async (_request, incoming) => {
    signal = incoming
    return await new Promise<RuntimeCommandResult>(resolve => {
      incoming?.addEventListener('abort', () => resolve({
        ...okResult,
        exitCode: null,
        aborted: true,
      }), { once: true })
    })
  })
  await fixture.worker.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(signal !== undefined)
  assert.equal(signal.aborted, false)
  fixture.worker.dispose()
  await fixture.worker.settled()
  assert.equal(signal.aborted, true)
  assert.equal(fixture.issues.records.get('issue-1')?.status, 'failed')
})

test('RuntimeCommandWorker：成功执行一次、写评论、回写 success', async () => {
  let runs = 0
  const fixture = workerFixture(baseRecord(), async () => { runs += 1; return okResult })
  await fixture.worker.tick()
  await fixture.worker.settled()
  assert.equal(runs, 1)
  assert.equal(fixture.issues.records.get('issue-1')?.status, 'success')
  assert.equal(fixture.comments.length, 1)
  assert.match(fixture.comments[0]!.body, /exit code: 0/)
  assert.equal(fixture.published.length, 1)
  assert.equal(fixture.finalized[0]?.status, 'success')
})

test('RuntimeCommandWorker：本地 claim 丢失时不再发第二条结果评论', async () => {
  const box: { fixture?: ReturnType<typeof workerFixture> } = {}
  const fixture = workerFixture(baseRecord(), async () => {
    await box.fixture!.issues.update('issue-1', draft => { draft.status = 'pending'; return true })
    return okResult
  })
  box.fixture = fixture
  await fixture.worker.tick()
  await fixture.worker.settled()
  assert.equal(fixture.issues.records.get('issue-1')?.status, 'pending')
  assert.equal(fixture.comments.length, 0)
  assert.equal(fixture.finalized.length, 0)
})

test('RuntimeCommandWorker：非零 exit 回写 failed；非法 payload 不执行', async () => {
  let runs = 0
  const failed = workerFixture(baseRecord(), async () => {
    runs += 1
    return { ...okResult, exitCode: 2, stderr: 'boom' }
  })
  await failed.worker.tick()
  await failed.worker.settled()
  assert.equal(failed.issues.records.get('issue-1')?.status, 'failed')

  const invalid = workerFixture(baseRecord({
    assignerMeta: { runtime: { arguments: {} } },
  }), async () => { runs += 1; return okResult })
  await invalid.worker.tick()
  await invalid.worker.settled()
  assert.equal(runs, 1)
  assert.equal(invalid.issues.records.get('issue-1')?.status, 'abandoned')
  assert.match(invalid.comments[0]!.body, /invalid payload/)
})

test('RuntimeCommandWorker：目标 instance 不匹配时不执行', async () => {
  let runs = 0
  const fixture = workerFixture(baseRecord({ assigneeInstance: 'other:3080' }), async () => {
    runs += 1
    return okResult
  })
  await fixture.worker.tick()
  await fixture.worker.settled()
  assert.equal(runs, 0)
  assert.equal(fixture.issues.records.get('issue-1')?.status, 'accepted')
})

test('RuntimeCommandWorker：cwd 必须是已注册 workspace，且不能逃出 workspace', async () => {
  let runs = 0
  const outside = workerFixture(baseRecord(), async () => { runs += 1; return okResult },
    async () => ({ id: 'ws-1', path: '/tmp/other' }))
  await outside.worker.tick()
  await outside.worker.settled()
  assert.equal(runs, 0)
  assert.equal(outside.issues.records.get('issue-1')?.status, 'abandoned')
  assert.match(outside.comments[0]!.body, /outside the resolved workspace/)

  const unknown = workerFixture(baseRecord(), async () => { runs += 1; return okResult },
    async () => undefined)
  await unknown.worker.tick()
  await unknown.worker.settled()
  assert.equal(runs, 0)
  assert.equal(unknown.issues.records.get('issue-1')?.status, 'abandoned')
  assert.match(unknown.comments[0]!.body, /not a registered workspace/)
})

test('RuntimeCommandWorker：sandbox denied 即使 exit 0 也判 failed', async () => {
  const fixture = workerFixture(baseRecord(), async () => ({
    ...okResult,
    sandboxMode: 'workspace-write',
    sandboxDenied: true,
  }))
  await fixture.worker.tick()
  await fixture.worker.settled()
  assert.equal(fixture.issues.records.get('issue-1')?.status, 'failed')
  assert.match(fixture.comments[0]!.body, /sandbox-denied/)
})

test('RuntimeCommandWorker：跨账号默认拒绝；refused 也标记 abandoned', async () => {
  let runs = 0
  const cross = workerFixture(baseRecord({ assigner: 'other' }), async () => {
    runs += 1
    return okResult
  })
  await cross.worker.tick()
  await cross.worker.settled()
  assert.equal(runs, 0)
  assert.equal(cross.issues.records.get('issue-1')?.status, 'abandoned')

  const { RuntimeCommandRefusedError } = await import('../src/host/pipeline/runtime-command.ts')
  const refused = workerFixture(baseRecord(), async () => {
    throw new RuntimeCommandRefusedError('no sandbox')
  })
  await refused.worker.tick()
  await refused.worker.settled()
  assert.equal(refused.issues.records.get('issue-1')?.status, 'abandoned')
  assert.match(refused.comments[0]!.body, /no sandbox/)
})
