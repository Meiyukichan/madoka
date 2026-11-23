/**
 * 任务详情：**13 个分区**（顺序固定，空分区显示占位而不是消失，避免高度跳动）。
 *
 * 分区：概览 / 状态 / 紧急度 / 执行记录 / 验收 / 清单 / 依赖 / 关系 / 评论 / 产物 / 输入件 / 定时 / 操作
 *
 * @module dsh-magica-teamwork/client/detail/task-detail
 */
import type { ReactNode } from 'react'

import { Badge, Button, Empty } from '../components/index.js'
import type { BoardCard } from '../model/columns.js'
import { checklistDone } from '../model/columns.js'
import { labelOf, type Lang } from '../model/labels.js'

/** 详情数据（宿主注入）。 */
export interface TaskDetailData {
  task: BoardCard & {
    detail?: string
    workspaceId?: string
    model?: string
    permission?: string
    issueId?: string
    blocked?: boolean
    execution?: { mode?: string; cron?: string }
    claimedBy?: string
    acceptanceInjectedAt?: number
    acceptanceFailedAt?: number
    dispatchedIssueCount?: number
  }
  executions?: readonly { id: string; outcome: string; startedAt: number; endedAt?: number; trigger?: string; error?: string }[]
  checklist?: readonly { text: string; done: boolean }[]
  dependsOn?: readonly string[]
  links?: { assigneeTaskId?: string; assigneeSessionId?: string; assignerSessionId?: string }
  comments?: readonly { id: string; body: string; role: string; createdAt: number; authorType?: string }[]
  artifacts?: readonly string[]
  attachments?: readonly { name: string; description?: string }[]
  acceptance?: readonly { id: string; type: string; title: string; text: string }[]
  nextRunAt?: string
}

/** props。 */
export interface TaskDetailProps {
  data: TaskDetailData
  lang?: Lang
  onClose?: () => void
  onRun?: () => void
  onCancel?: () => void
  onMove?: (status: string) => void
  onComment?: (body: string) => void
  canRun?: boolean
}

/** 一个分区。 */
function Section(props: { title: string; children: ReactNode }): ReactNode {
  return (
    <section className="dsh-atw-detail-section">
      <h4>{props.title}</h4>
      {props.children}
    </section>
  )
}

/** 详情。 */
export function TaskDetail(props: TaskDetailProps): ReactNode {
  const lang = props.lang ?? 'zh'
  const data = props.data
  const task = data.task
  const progress = checklistDone(task)
  const t = (key: '概览' | '状态' | '紧急度' | '执行记录' | '验收' | '清单' | '依赖' | '关系' | '评论' | '产物' | '输入件' | '定时' | '操作', en: string): string =>
    lang === 'en' ? en : key

  return (
    <div className="dsh-atw-root">
      <div className="dsh-atw-toolbar">
        <strong style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>{task.title}</strong>
        <Button onClick={props.onClose}>{lang === 'en' ? 'Close' : '关闭'}</Button>
      </div>

      <div style={{ padding: '0 12px 12px', overflow: 'auto' }}>
        <Section title={t('概览', 'Overview')}>
          <div className="dsh-atw-card-meta">
            <Badge>{labelOf('column', task.status, lang)}</Badge>
            <span>{task.id}</span>
            {task.workspaceId === undefined ? null : <span>{task.workspaceId}</span>}
            {task.model === undefined ? null : <span>{task.model}</span>}
            {task.permission === undefined ? null : <span>{task.permission}</span>}
          </div>
          <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{task.detail === undefined || task.detail === '' ? '—' : task.detail}</div>
        </Section>

        <Section title={t('状态', 'Status')}>
          <div className="dsh-atw-card-meta">
            <Badge>{labelOf('status', task.status, lang)}</Badge>
            {task.blocked === true ? <Badge tone="warn">blocked</Badge> : null}
            {task.claimedBy === undefined ? null : <Avatar name={task.claimedBy} />}
            {task.hasRunning === true ? <Badge tone="ok">{labelOf('outcome', 'running', lang)}</Badge> : null}
          </div>
        </Section>

        <Section title={t('紧急度', 'Urgency')}>
          <Badge tone={task.urgency === 'urgent' ? 'urgent' : task.urgency === 'high' ? 'warn' : 'neutral'}>
            {labelOf('urgency', task.urgency, lang)}
          </Badge>
        </Section>

        <Section title={t('执行记录', 'Executions')}>
          {(data.executions ?? []).length === 0 ? (
            <Empty text={lang === 'en' ? 'No executions yet' : '还没有执行记录'} />
          ) : (
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
              <tbody>
                {(data.executions ?? []).map(execution => (
                  <tr key={execution.id}>
                    <td>{execution.id}</td>
                    <td>{labelOf('outcome', execution.outcome, lang)}</td>
                    <td>{execution.trigger === undefined ? '—' : labelOf('trigger', execution.trigger, lang)}</td>
                    <td>{execution.error ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Section>

        <Section title={t('验收', 'Acceptance')}>
          {(data.acceptance ?? []).length === 0 ? (
            <Empty text={lang === 'en' ? 'No acceptance strategy' : '没有验收策略'} />
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(data.acceptance ?? []).map(item => (
                <li key={item.id}>{`[${item.type}] ${item.title}`}</li>
              ))}
            </ul>
          )}
          {task.acceptanceInjectedAt === undefined ? null : (
            <div className="dsh-atw-card-meta">{lang === 'en' ? 'Acceptance round injected' : '验收轮已注入'}</div>
          )}
          {task.acceptanceFailedAt === undefined ? null : (
            <div className="dsh-atw-card-meta">{lang === 'en' ? 'Acceptance failed once' : '验收失败过一次'}</div>
          )}
        </Section>

        <Section title={t('清单', 'Checklist')}>
          {progress.total === 0 ? (
            <Empty text={lang === 'en' ? 'No checklist' : '没有清单'} />
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {(data.checklist ?? []).map((item, index) => (
                <li key={`${item.text}-${index}`}>{`${item.done ? '☑' : '☐'} ${item.text}`}</li>
              ))}
            </ul>
          )}
        </Section>

        <Section title={t('依赖', 'Dependencies')}>
          {(data.dependsOn ?? []).length === 0 ? <Empty text="—" /> : <div className="dsh-atw-card-meta">{(data.dependsOn ?? []).join(', ')}</div>}
        </Section>

        <Section title={t('关系', 'Links')}>
          <div className="dsh-atw-card-meta">
            {task.issueId === undefined ? <span>—</span> : <Badge>{task.issueId}</Badge>}
            {data.links?.assigneeSessionId === undefined ? null : <Badge>{data.links.assigneeSessionId}</Badge>}
            {data.links?.assignerSessionId === undefined ? null : <Badge>{data.links.assignerSessionId}</Badge>}
          </div>
        </Section>

        <Section title={t('评论', 'Comments')}>
          {(data.comments ?? []).length === 0 ? (
            <Empty text={lang === 'en' ? 'No comments' : '还没有评论'} />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(data.comments ?? []).map(comment => (
                <div key={comment.id} className="dsh-atw-card">
                  <div className="dsh-atw-card-meta"><Badge>{comment.role}</Badge><span>{comment.authorType ?? ''}</span></div>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{comment.body}</div>
                </div>
              ))}
            </div>
          )}
        </Section>

        <Section title={t('产物', 'Artifacts')}>
          {(data.artifacts ?? []).length === 0 ? <Empty text="—" /> : <ul style={{ margin: 0, paddingLeft: 18 }}>{(data.artifacts ?? []).map(item => <li key={item}>{item}</li>)}</ul>}
        </Section>

        <Section title={t('输入件', 'Inputs')}>
          {(data.attachments ?? []).length === 0 ? <Empty text="—" /> : <ul style={{ margin: 0, paddingLeft: 18 }}>{(data.attachments ?? []).map(item => <li key={item.name}>{item.description === undefined ? item.name : `${item.name} — ${item.description}`}</li>)}</ul>}
        </Section>

        <Section title={t('定时', 'Schedule')}>
          {task.execution?.mode !== 'scheduled' ? (
            <Empty text={lang === 'en' ? 'Not scheduled' : '非定时卡'} />
          ) : (
            <div className="dsh-atw-card-meta">
              <Badge>{task.execution.cron ?? '—'}</Badge>
              <span>{data.nextRunAt ?? '—'}</span>
            </div>
          )}
        </Section>

        <Section title={t('操作', 'Actions')}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {props.canRun === false ? null : <Button variant="primary" onClick={props.onRun}>{lang === 'en' ? 'Run now' : '立即执行'}</Button>}
            <Button onClick={props.onCancel}>{lang === 'en' ? 'Cancel run' : '取消执行'}</Button>
            <Button onClick={() => { props.onMove?.('in_review') }}>{lang === 'en' ? 'Submit for review' : '提交验收'}</Button>
          </div>
        </Section>
      </div>
    </div>
  )
}

/** 头像（内部小工具，避免为它单独建文件）。 */
function Avatar(props: { name: string }): ReactNode {
  return <span className="dsh-atw-avatar">{props.name.slice(0, 1).toUpperCase()}</span>
}
