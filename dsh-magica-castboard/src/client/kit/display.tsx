/**
 * 展示件：状态圆环与 Markdown 容器。
 *
 * @module dsh-magica-castboard/client/kit/display
 */
import { MarkdownText, type MarkdownLabels } from '@deepseek-ai/dsh-client-ui-primitives'
import { useMemo, type ReactNode } from 'react'

import type { Translate } from '../labels/index.ts'

/** 圆环几何（viewBox 14×14）。 */
const CENTER = 7
const OUTER = 6
const INNER = 3.5

function wedge(radius: number, ratio: number): string {
  const angle = ratio * Math.PI * 2
  const x = CENTER + radius * Math.sin(angle)
  const y = CENTER - radius * Math.cos(angle)
  return `M${CENTER},${CENTER} L${CENTER},${CENTER - radius} A${radius},${radius} 0 ${ratio > 0.5 ? 1 : 0},1 ${x},${y} Z`
}

function Ring({ ratio, children }: { ratio: number; children?: ReactNode }) {
  return (
    <>
      <circle cx={CENTER} cy={CENTER} r={OUTER} fill="none" stroke="currentColor" strokeWidth={1.5} />
      {ratio === 1
        ? <circle cx={CENTER} cy={CENTER} r={OUTER} fill="currentColor" />
        : ratio > 0 ? <path d={wedge(INNER, ratio)} fill="currentColor" /> : null}
      {children}
    </>
  )
}

/** 状态圆环：待规划是点圈，待办空环，进行中半饼，待验收 3/4，完成实心勾。 */
export function StatusOrb({ status, size = 14 }: { status: string; size?: number }) {
  const body = status === 'issue'
    ? (
        <g>
          {Array.from({ length: 16 }, (_, index) => {
            const angle = (index / 16) * Math.PI * 2 - Math.PI / 2
            return <circle key={index} cx={CENTER + OUTER * Math.cos(angle)} cy={CENTER + OUTER * Math.sin(angle)} r={0.9} fill="currentColor" />
          })}
        </g>
      )
    : status === 'todo' ? <Ring ratio={0} />
      : status === 'in_progress' ? <Ring ratio={0.5} />
        : status === 'in_review' ? <Ring ratio={0.75} />
          : status === 'done'
            ? (
                <Ring ratio={1}>
                  <path d="M10.95 4.25c.33.33.33.87 0 1.2l-5 5a.85.85 0 0 1-1.2 0l-2-2a.85.85 0 1 1 1.2-1.2l1.4 1.4 4.4-4.4a.85.85 0 0 1 1.2 0Z" fill="var(--dsw-alias-bg-layer-1)" stroke="none" />
                </Ring>
              )
            : (
                <Ring ratio={0}>
                  <line
                    x1={CENTER + INNER * Math.cos(Math.PI * 0.75)}
                    y1={CENTER - INNER * Math.sin(Math.PI * 0.75)}
                    x2={CENTER + INNER * Math.cos(-Math.PI * 0.25)}
                    y2={CENTER - INNER * Math.sin(-Math.PI * 0.25)}
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeLinecap="round"
                  />
                </Ring>
              )
  return (
    <svg className="lt-orb" data-status={status} width={size} height={size} viewBox="0 0 14 14" fill="none" aria-hidden>
      {body}
    </svg>
  )
}

/** 官方 Markdown 渲染（表格 / 代码复制 / 脚注都由它提供）。 */
export function MarkdownBody({ text, t }: { text: string; t: Translate }) {
  const labels = useMemo<MarkdownLabels>(() => ({
    code: { copyLabel: t('common.copy'), copiedLabel: t('common.copied') },
    footnotes: t('common.footnotes'),
  }), [t])
  return (
    <div className="lt-md">
      <MarkdownText text={text} labels={labels} />
    </div>
  )
}
