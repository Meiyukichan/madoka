/**
 * 卡片文案：`ix.*` 命名空间，中英两份键集必须一致。
 *
 * @module dsh-magica-spellbook/client/panel/locales
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots' // 合并 LocaleNamespaceMap

/** 命名空间（`ctx.locale.register` 与槽位 `locale:` 都必须用它）。 */
export const INTERACTION_LOCALE_NS = 'magica-interaction'

/** 中文文案（key 的唯一真相）。 */
export const zh = {
  'ix.error.incomplete': '还有题目没有作答',
  'ix.error.unanswered': '请先选择或填写答案',
  'ix.prev': '上一题',
  'ix.next': '下一题',
  'ix.submit': '提交',
  'ix.submitting': '提交中…',
  'ix.skip': '跳过本题',
  'ix.cancel': '取消',
  'ix.minimize': '最小化',
  'ix.expand': '展开',
  'ix.recommended': '推荐',
  'ix.custom': '其他答案',
  'ix.progress': '{current}/{total}',
  'ix.approval.waiting': '等待你的决定',
  'ix.approval.allow': '允许一次',
  'ix.approval.reject': '拒绝',
  'ix.approval.escalation': '该操作请求临时提升沙箱权限',
  'ix.approval.detailAria': '操作详情',
  'ix.copy': '复制',
  'ix.copied': '已复制',
  'ix.footnotes': '脚注',
  'ix.planReview': '计划评审',
  // 目录选择器（`DirectoryBrowser`）用同一命名空间：消费方注册一次就够，
  // 否则按文档装配后组件里全是 `browser.*` 原文（G1 核对表 P0-4）
  'browser.title': '选择目录',
  'browser.loading': '正在读取…',
  'browser.open': '打开',
  'browser.cancel': '取消',
  'browser.create': '新建',
  'browser.newFolder': '新建文件夹',
  'browser.folderName': '文件夹名称',
  'browser.showHidden': '显示隐藏项',
  'browser.editPath': '编辑路径',
  'browser.truncated': '目录太大，只显示前一部分',
  'browser.empty': '这里没有可显示的目录',
  'browser.drives': '磁盘驱动器',
} as const

/** 文案 key 域。 */
export type InteractionKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** spellbook 的待决交互文案（`ix.*` + `browser.*`）。 */
    'magica-interaction': InteractionKey
  }
}

/** 英文文案（与中文逐 key 对齐）。 */
export const en: Record<InteractionKey, string> = {
  'ix.error.incomplete': 'Some questions are still unanswered',
  'ix.error.unanswered': 'Pick or type an answer first',
  'ix.prev': 'Previous',
  'ix.next': 'Next',
  'ix.submit': 'Submit',
  'ix.submitting': 'Submitting…',
  'ix.skip': 'Skip this question',
  'ix.cancel': 'Cancel',
  'ix.minimize': 'Minimize',
  'ix.expand': 'Expand',
  'ix.recommended': 'Recommended',
  'ix.custom': 'Other answer',
  'ix.progress': '{current}/{total}',
  'ix.approval.waiting': 'Waiting for your decision',
  'ix.approval.allow': 'Allow once',
  'ix.approval.reject': 'Reject',
  'ix.approval.escalation': 'This operation asks for a temporary sandbox escalation',
  'ix.approval.detailAria': 'Operation detail',
  'ix.copy': 'Copy',
  'ix.copied': 'Copied',
  'ix.footnotes': 'Footnotes',
  'ix.planReview': 'Plan review',
  'browser.title': 'Choose a folder',
  'browser.loading': 'Loading…',
  'browser.open': 'Open',
  'browser.cancel': 'Cancel',
  'browser.create': 'Create',
  'browser.newFolder': 'New folder',
  'browser.folderName': 'Folder name',
  'browser.showHidden': 'Show hidden items',
  'browser.editPath': 'Edit path',
  'browser.truncated': 'This folder is large; only the first entries are shown',
  'browser.empty': 'No folders to show here',
  'browser.drives': 'Drives',
}

/** 翻译函数形状（比 dsh 的 `Translate` 更窄：参数值必须是字符串）。 */
export type InteractionTranslate = (key: InteractionKey, params?: Record<string, string>) => string

/** 用字典造一个 `t`（surface 在没有 locale 服务时用它兜底）。 */
export function makeTranslate(dict: Record<InteractionKey, string>): InteractionTranslate {
  return (key, params) => {
    const template = dict[key] ?? key
    if (params === undefined) return template
    return template.replace(/\{(\w+)\}/g, (match, name: string) => params[name] ?? match)
  }
}
