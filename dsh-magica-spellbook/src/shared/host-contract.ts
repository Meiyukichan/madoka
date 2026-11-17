/**
 * 宿主服务契约：本库的会话/交互能力全部来自消费方插件传进来的 `ctx`。
 *
 * 为什么不用 `peerDependencies` 表达这些：它们是 **cordis 服务**，不是运行时的 npm 依赖 ——
 * 本库对 `@deepseek-ai/*` 运行时零导入（只有 `import type`；`verify` 会断言宿主产物里没有该子串），
 * 服务由宿主插件注册、由消费方插件 `inject` 声明。package.json 无法表达"需要某个 service"，
 * 所以在这里把契约显式列出来：消费方可以 `export const inject = requiredHostServices()`，
 * 也可以在宿主升级后用它自检。
 *
 * @module dsh-magica-spellbook/shared/host-contract
 */

/** 一条宿主服务要求。 */
export interface HostServiceRequirement {
  /** 服务名（`ctx.get(name)` 用的键）。 */
  name: string
  /** 缺了是否直接不可用（`true` 时库会抛可读错误或拒绝装配）。 */
  required: boolean
  /** 提供方（dsh 侧的包名，仅作文档指引；本库不 import 它）。 */
  providedBy: string
  /** 用途与缺失时的行为。 */
  note: string
}

/** 宿主侧（上下文里的）服务要求。 */
export const HOST_SERVICES: readonly HostServiceRequirement[] = [
  {
    name: 'agents',
    required: true,
    providedBy: 'dsh-agent',
    note: '建会话 / 续跑 / whenIdle / cancel；缺失时 resolveAgents() 抛错并提示 inject: ["agents"]',
  },
  {
    name: 'agentDefaultModel',
    required: false,
    providedBy: 'dsh-agent-default-model',
    note: '缺省模型来源；未显式传 `model` 且该服务缺失时抛 "no model route"',
  },
  {
    name: 'agentPresets',
    required: false,
    providedBy: 'dsh-agent-preset-registry',
    note: 'preset 解析与 setup 组合；缺失时退回 dsh 默认装配',
  },
  {
    name: 'permissionPresets',
    required: false,
    providedBy: 'dsh-agent',
    note: '权限档位名 → 实际 sandbox 值；缺失时按原样透传',
  },
  {
    name: 'sessionTitle',
    required: false,
    providedBy: 'dsh-session-title',
    note: '传了 `title` 时钉标题；缺失时静默跳过（装饰性）',
  },
  {
    name: 'workspaceRegistry',
    required: false,
    providedBy: 'dsh-workspace',
    note: '把正式会话挂进 GUI 工作区；缺失时 state.attachError 说明原因，会话照跑',
  },
  {
    name: 'logger',
    required: false,
    providedBy: 'dsh 宿主',
    note: '诊断告警通道；缺失时静默（不影响功能）',
  },
  {
    name: 'dshHomePath',
    required: false,
    providedBy: 'dsh 宿主',
    note: '`$DSH_HOME` 解析；缺失时回退 `os.homedir()/.dsh`',
  },
]

/** 宿主侧会用到的事件（`ctx.on`）与 waterfall 认领点。 */
export const HOST_EVENTS: readonly { event: string; mode: 'on' | 'waterfall' }[] = [
  { event: 'session/event', mode: 'on' },
  { event: 'agent/disposed', mode: 'on' },
  { event: 'user-questions/request', mode: 'waterfall' },
  { event: 'approval/request', mode: 'waterfall' },
]

/** 浏览器侧（client context）的服务要求。 */
export const CLIENT_SERVICES: readonly HostServiceRequirement[] = [
  {
    name: 'uiSession',
    required: true,
    providedBy: 'dsh-client-ui-session',
    note: 'registerPendingInteraction；缺失时 createInteractionSurface() 返回 undefined',
  },
  {
    name: 'slots',
    required: false,
    providedBy: 'dsh-client-ui-slots',
    note: '往 conversation.composer 注册接管；缺失时只发布载体、不占输入框',
  },
  {
    name: 'locale',
    required: false,
    providedBy: 'dsh-client-locale',
    note: '文案命名空间；缺失时用自带 zh 字典兜底',
  },
]

/**
 * 需要写进消费方 `inject` 的服务名（只含 required 的）。
 * @returns 形如 `['agents']` 的数组，可直接用于 `export const inject`。
 */
export function requiredHostServices(): string[] {
  return HOST_SERVICES.filter((item) => item.required).map((item) => item.name)
}

/**
 * 生成一段人读的契约摘要（用于 README 生成或启动时的诊断输出）。
 * @returns 多行文本，每行一个服务。
 */
export function describeHostRequirements(): string {
  const line = (item: HostServiceRequirement): string =>
    `${item.required ? '必需' : '可选'} ${item.name} ← ${item.providedBy}：${item.note}`
  return [
    'host services:',
    ...HOST_SERVICES.map((item) => `  ${line(item)}`),
    'host events:',
    ...HOST_EVENTS.map((item) => `  ${item.mode} ${item.event}`),
    'client services:',
    ...CLIENT_SERVICES.map((item) => `  ${line(item)}`),
  ].join('\n')
}
