/**
 * 六张标签映射表（列 / 状态 / 迁移 / 紧急度 / 结局 / 触发），中英双语。
 *
 * 组件只查表、不拼字符串；缺键回退原值（不抛错、不显示 undefined）。
 *
 * @module dsh-magica-teamwork/client/model/labels
 */

/** 语言。 */
export type Lang = 'zh' | 'en'

/** 一组双语文案。 */
export interface Bilingual {
  zh: string
  en: string
}

/** 取文案。 */
export function pick(text: Bilingual | undefined, lang: Lang, fallback = ''): string {
  if (text === undefined) return fallback
  return text[lang] || text.zh || text.en || fallback
}

/** 1) 看板列。 */
export const COLUMN_LABELS: Record<string, Bilingual> = {
  todo: { zh: '待办', en: 'To do' },
  in_progress: { zh: '进行中', en: 'In progress' },
  in_review: { zh: '待验收', en: 'In review' },
  done: { zh: '已完成', en: 'Done' },
  canceled: { zh: '已取消', en: 'Canceled' },
  archived: { zh: '已归档', en: 'Archived' },
  abandoned: { zh: '已遗弃', en: 'Abandoned' },
}

/** 2) 状态标签（同列但用于徽标，措辞更短）。 */
export const STATUS_LABELS: Record<string, Bilingual> = {
  todo: { zh: '待办', en: 'To do' },
  in_progress: { zh: '进行', en: 'Doing' },
  in_review: { zh: '待验收', en: 'Review' },
  done: { zh: '完成', en: 'Done' },
  canceled: { zh: '取消', en: 'Canceled' },
  archived: { zh: '归档', en: 'Archived' },
  abandoned: { zh: '遗弃', en: 'Abandoned' },
}

/** 3) 迁移动作（拖拽到某列时菜单里显示什么）。 */
export const TRANSITION_LABELS: Record<string, Bilingual> = {
  'todo->in_progress': { zh: '开始执行', en: 'Start' },
  'in_progress->in_review': { zh: '提交验收', en: 'Submit for review' },
  'in_progress->todo': { zh: '退回待办', en: 'Back to todo' },
  'in_review->done': { zh: '验收通过', en: 'Accept' },
  'in_review->todo': { zh: '退回返工', en: 'Send back' },
  '*->canceled': { zh: '取消', en: 'Cancel' },
  '*->archived': { zh: '归档', en: 'Archive' },
  '*->abandoned': { zh: '遗弃', en: 'Abandon' },
}

/** 4) 紧急度。 */
export const URGENCY_LABELS: Record<string, Bilingual> = {
  urgent: { zh: '紧急', en: 'Urgent' },
  high: { zh: '高', en: 'High' },
  normal: { zh: '普通', en: 'Normal' },
  low: { zh: '低', en: 'Low' },
  relaxed: { zh: '不急', en: 'Relaxed' },
}

/** 5) 执行结局。 */
export const OUTCOME_LABELS: Record<string, Bilingual> = {
  running: { zh: '执行中', en: 'Running' },
  succeeded: { zh: '成功', en: 'Succeeded' },
  failed: { zh: '失败', en: 'Failed' },
  cancelled: { zh: '被取消', en: 'Cancelled' },
}

/** 6) 触发方式。 */
export const TRIGGER_LABELS: Record<string, Bilingual> = {
  user: { zh: '手动', en: 'Manual' },
  dispatch: { zh: '派发', en: 'Dispatch' },
  scheduled: { zh: '定时', en: 'Scheduled' },
  acceptance: { zh: '验收', en: 'Acceptance' },
  assist: { zh: '辅助', en: 'Assist' },
  comment: { zh: '评论唤醒', en: 'Comment' },
}

/** 六张表的总入口（测试与组件统一从这里取）。 */
export const LABEL_TABLES = {
  column: COLUMN_LABELS,
  status: STATUS_LABELS,
  transition: TRANSITION_LABELS,
  urgency: URGENCY_LABELS,
  outcome: OUTCOME_LABELS,
  trigger: TRIGGER_LABELS,
} as const

/** 查表；查不到原样返回 key。 */
export function labelOf(table: keyof typeof LABEL_TABLES, key: string, lang: Lang): string {
  return pick(LABEL_TABLES[table][key], lang, key)
}

/** 迁移文案：先查精确 key，再退通配。 */
export function transitionLabel(from: string, to: string, lang: Lang): string {
  return labelOf('transition', `${from}->${to}`, lang) === `${from}->${to}`
    ? labelOf('transition', `*->${to}`, lang)
    : labelOf('transition', `${from}->${to}`, lang)
}
