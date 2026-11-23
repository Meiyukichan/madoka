/**
 * 待决交互的应答面。
 *
 * @module dsh-magica-castboard/client/data/endpoints/interactions
 */
import { apiPost } from '../api.ts'

export function apiAnswerApproval(id: string, approved: boolean, note?: string): Promise<{ id: string; approved: boolean }> {
  return apiPost('/magica/interactions/approval/answer', note === undefined ? { id, approved } : { id, approved, note })
}

export function apiAnswerQuestion(id: string, answer: string, selected?: readonly string[]): Promise<{ id: string }> {
  return apiPost('/magica/interactions/question/answer', {
    id,
    answer,
    ...(selected === undefined || selected.length === 0 ? {} : { selected }),
  })
}

export function apiCancelQuestion(id: string): Promise<{ id: string }> {
  return apiPost('/magica/interactions/question/cancel', { id })
}
