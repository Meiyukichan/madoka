/**
 * 项目管理页：四页容器由 teamwork 组件库提供，castboard 只负责注入 locale。
 *
 * @module dsh-magica-castboard/client/features/teamwork/page
 */
import { TeamworkPanel } from '@meiyukichan/dsh-magica-teamwork/client'
import type { ReactNode } from 'react'

import type { Translate } from '../../labels/index.ts'
import { interactionCommentView } from '../interactions/control-comment-card.tsx'

function currentLang(): 'zh' | 'en' {
  try {
    return document.documentElement.lang.toLowerCase().startsWith('en') ? 'en' : 'zh'
  } catch {
    return 'zh'
  }
}

export function TeamworkPage(props: { t: Translate }): ReactNode {
  return (
    <TeamworkPanel
      t={props.t}
      lang={currentLang()}
      describeComment={comment => interactionCommentView(comment, props.t)}
    />
  )
}
