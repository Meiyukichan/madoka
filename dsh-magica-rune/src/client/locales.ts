/**
 * i18n 字典与命名空间声明。
 *
 * 0.2 要求：`ctx.locale.register(NS, { zh, en })` 的 **zh / en 键集必须完全一致**，
 * 且与 `LocaleNamespaceMap['settings.ability']` 的键集一致（类型化重载会校验）。
 * 因此这里用一张 `keys` 常量同时驱动两份字典。
 * @module dsh-magica-rune/client/locales
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** 能力管理页的文案命名空间。 */
    'settings.ability': AbilityLocaleKey
  }
}

export const NS = 'settings.ability'

/** 全部文案键（目录 / 分组 / 交互 / 占位）。 */
export type AbilityLocaleKey =
  | 'nav' | 'desc' | 'close'
  | 'tab.tools' | 'tab.skills'
  | 'scope.global' | 'scope.workspace' | 'scope.placeholder'
  | 'search.tools' | 'search.skills'
  | 'empty.tools' | 'empty.skills'
  | 'noResults.tools' | 'noResults.skills'
  | 'tool.builtin'
  | 'disable.title' | 'disable.desc' | 'disable.confirm' | 'disable.cancel'
  | 'disable.batchTitle' | 'disable.batchDesc'
  | 'loading' | 'error'
  | 'nudge.title' | 'nudge.description' | 'nudge.increase' | 'nudge.decrease' | 'nudge.error'
  | 'cat.file' | 'cat.shell' | 'cat.image' | 'cat.agent' | 'cat.job' | 'cat.goal'
  | 'cat.ralph' | 'cat.cordis' | 'cat.mcp' | 'cat.misc' | 'cat.builtin' | 'cat.plugin-other'
  | 'cat.web' | 'cat.workflow' | 'cat.plugin'

export const zh: Record<AbilityLocaleKey, string> = {
  nav: '能力管理',
  desc: '管理工具与技能的启用与禁用，可在全局或工作区配置。工作区配置叠加在全局之上。',
  close: '关闭',
  'tab.tools': '工具',
  'tab.skills': '技能',
  'scope.global': '全局',
  'scope.placeholder': '未选择',
  'scope.workspace': '工作区',
  'search.tools': '搜索工具',
  'search.skills': '搜索技能',
  'empty.tools': '暂无工具配置',
  'empty.skills': '暂无技能',
  'noResults.tools': '无匹配工具',
  'noResults.skills': '无匹配技能',
  'tool.builtin': '内置禁用',
  'disable.title': '禁用内置工具',
  'disable.desc': '该工具为 DSH 内置工具，禁用后可能导致 DSH 对话功能无法正常使用，是否禁用 {name}？',
  'disable.confirm': '禁用',
  'disable.cancel': '取消',
  'disable.batchTitle': '批量禁用内置工具',
  'disable.batchDesc': '该分组含 {count} 个 DSH 内置工具，批量禁用后可能导致 DSH 对话功能无法正常使用，是否继续？',
  loading: '加载中…',
  'nudge.title': '提醒阈值',
  'nudge.description': '连续多少次工具调用没有文字输出时，插话提醒你给用户进展',
  'nudge.increase': '增大阈值',
  'nudge.decrease': '减小阈值',
  'nudge.error': '保存失败',
  error: '加载失败',
  'cat.file': '文件操作',
  'cat.shell': 'Shell',
  'cat.image': '图像',
  'cat.agent': '子 Agent',
  'cat.job': '后台 Job',
  'cat.goal': '目标管理',
  'cat.ralph': 'Ralph 循环',
  'cat.cordis': 'Cordis 动态插件',
  'cat.mcp': 'MCP 服务器',
  'cat.web': 'Web',
  'cat.workflow': '工作流',
  'cat.plugin': '插件',
  'cat.misc': '其它',
  'cat.builtin': '内置禁用',
  'cat.plugin-other': '其它插件',
}

export const en: Record<AbilityLocaleKey, string> = {
  nav: 'Ability',
  desc: 'Manage tool and skill enablement globally or per workspace. Workspace settings overlay the global ones.',
  close: 'Close',
  'tab.tools': 'Tools',
  'tab.skills': 'Skills',
  'scope.global': 'Global',
  'scope.placeholder': 'Not selected',
  'scope.workspace': 'Workspace',
  'search.tools': 'Search tools',
  'search.skills': 'Search skills',
  'empty.tools': 'No tool configuration yet',
  'empty.skills': 'No skills',
  'noResults.tools': 'No matching tools',
  'noResults.skills': 'No matching skills',
  'tool.builtin': 'Built-in disabled',
  'disable.title': 'Disable a built-in tool',
  'disable.desc': 'This tool ships with DSH. Disabling it may break normal conversation features. Disable {name}?',
  'disable.confirm': 'Disable',
  'disable.cancel': 'Cancel',
  'disable.batchTitle': 'Disable built-in tools in bulk',
  'disable.batchDesc': 'This group contains {count} DSH built-in tools. Disabling them in bulk may break normal conversation features. Continue?',
  loading: 'Loading…',
  'nudge.title': 'Reminder threshold',
  'nudge.description': 'How many tool calls in a row without text before the plugin nudges you to update the user',
  'nudge.increase': 'Increase threshold',
  'nudge.decrease': 'Decrease threshold',
  'nudge.error': 'Could not save',
  error: 'Load failed',
  'cat.file': 'Files',
  'cat.shell': 'Shell',
  'cat.image': 'Image',
  'cat.agent': 'Sub-agent',
  'cat.job': 'Background Jobs',
  'cat.goal': 'Goals',
  'cat.ralph': 'Ralph Loop',
  'cat.cordis': 'Cordis Plugins',
  'cat.mcp': 'MCP Servers',
  'cat.web': 'Web',
  'cat.workflow': 'Workflow',
  'cat.plugin': 'Plugins',
  'cat.misc': 'Misc',
  'cat.builtin': 'Built-in disabled',
  'cat.plugin-other': 'Other plugins',
}
