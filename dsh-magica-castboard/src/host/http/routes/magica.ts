/**
 * `/magica/*`: reading and answering pending interactions.
 *
 * Answering can execute tools immediately, so beyond the dispatcher's write fence these
 * routes confirm that the current window holds the storage lease. The interaction
 * service is optional: reads return an empty list, answers return 501, and the UI
 * degrades.
 *
 * @module dsh-magica-castboard/host/http/routes/magica
 */
import type { Route } from '../router.ts'
import {
  bool,
  fail,
  objectBody,
  optionalString,
  pendingInteractionRecords,
  requireString,
  unavailable,
  type RouteDeps,
} from './shared.ts'

export function magicaRoutes(deps: RouteDeps): readonly Route[] {
  const requireOwner = (): void => {
    if (deps.isWritable()) return
    throw fail('forbidden', `本窗口只读：交互由另一个 dsh web 负责（${deps.ownerHint()}）`, 403)
  }

  const service = (): NonNullable<RouteDeps['interactions']> => {
    const interactions = deps.interactions
    if (interactions === undefined) throw unavailable('当前宿主没有接入待决交互服务')
    return interactions
  }

  return [
    {
      method: 'GET',
      path: '/magica/interactions',
      // The full list also ships with /state; this route serves callers that only ask for interactions.
      handler: async () => ({ interactions: await pendingInteractionRecords(deps.interactions) }),
    },

    {
      method: 'POST',
      path: '/magica/interactions/approval/answer',
      handler: async (context) => {
        requireOwner()
        const interactions = service()
        const body = objectBody(context)
        const id = requireString(body, 'id', 100)
        const approved = bool(body, 'approved')
        if (approved === null) throw fail('invalid_input', 'approved 必填（布尔）')
        const note = optionalString(body, 'note', 2000)
        const answered = await interactions.answerApproval(id, approved, note)
        if (!answered) throw fail('not_found', '没有这条待决审批', 404)
        return { id, approved }
      },
    },

    {
      method: 'POST',
      path: '/magica/interactions/question/answer',
      handler: async (context) => {
        requireOwner()
        const interactions = service()
        const body = objectBody(context)
        const id = requireString(body, 'id', 100)
        const answer = typeof body.answer === 'string' ? body.answer.trim().slice(0, 4000) : ''
        // Multi-select answers carry the whole selection; free text is optional.
        const rawSelected = body.selected
        if (rawSelected !== undefined && !Array.isArray(rawSelected)) {
          throw fail('invalid_input', 'selected 必须是字符串数组', 400)
        }
        const selected = rawSelected === undefined
          ? undefined
          : rawSelected.filter((item): item is string => typeof item === 'string' && item !== '')
        if (answer === '' && (selected === undefined || selected.length === 0)) {
          throw fail('invalid_input', 'answer 或 selected 至少给一个', 400)
        }
        const answered = await interactions.answerQuestion(id, answer, selected)
        if (!answered) throw fail('not_found', '没有这条待决提问', 404)
        return { id }
      },
    },

    {
      method: 'POST',
      path: '/magica/interactions/question/cancel',
      handler: async (context) => {
        requireOwner()
        const interactions = service()
        const body = objectBody(context)
        const id = requireString(body, 'id', 100)
        const cancelled = await interactions.cancelQuestion(id)
        if (!cancelled) throw fail('not_found', '没有这条待决提问', 404)
        return { id }
      },
    },
  ]
}
