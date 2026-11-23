/**
 * 侧栏「项目管理」图标：文件夹 + 看板线，16px，currentColor。
 *
 * @module dsh-magica-castboard/client/app/teamwork-icon
 */
import type { ReactNode } from 'react'

export function TeamworkIcon(): ReactNode {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M1.75 4.25A1.75 1.75 0 0 1 3.5 2.5h2.2c.52 0 1.01.23 1.34.63l.62.77h4.84a1.75 1.75 0 0 1 1.75 1.75v6.1a1.75 1.75 0 0 1-1.75 1.75h-8.75a1.75 1.75 0 0 1-1.75-1.75V4.25Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
      <path d="M5 8h6M5 10.75h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  )
}
