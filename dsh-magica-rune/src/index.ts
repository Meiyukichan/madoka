/**
 * host 入口：能力管理的两个通道 + 目录 HTTP。
 *
 * 组装顺序与理由见 docs/design/02 §11。一句话：先把 `state` 灌满，
 * 再按「工作区索引 → skill 遮蔽 → restrict → guard → catalog」装挂载点，
 * 最后一条 `loader/volatile-update` 通道驱动全部重挂，所有副作用在一个 `ctx.effect` 里收口。
 * @module dsh-magica-rune
 */

import type { DshContext } from './shared/dsh.ts'
import { Config, readConfig, type Config as RuneConfig } from './config.ts'
import { ABILITY_NS } from './namespace.ts'
import { GuardState } from './state.ts'
import { installWorkspaceIndex } from './workspace.ts'
import { installGuard } from './guard.ts'
import { installRestrict } from './restrict.ts'
import { installSkillGate } from './skill-gate.ts'
import { installCatalog } from './catalog.ts'
import { registerBuiltinSkill } from './builtin-skill.ts'
import { installNudge, type NudgeContext, type NudgeOptions } from './nudge.ts'
import { quietLoggers } from './quiet.ts'

export { Config }
export type { RuneConfig }
export { ABILITY_NS } from './namespace.ts'

/** 插件名（必须与 package.json 的 name 一致，loader 据此定位包）。 */
export const name = 'dsh-magica-rune'

/**
 * 硬依赖：这三个缺席时门禁无法工作。
 * `settings` / `skills` / `workspaceRegistry` / `agents` 走 `ctx.get` 可选降级。
 */
export const inject = ['tools', 'webServer', 'systemPrompt']

/** 关掉「插件」页为本 entry 自动生成的大表单（我们有自己的页面）。 */
function installSettingsSelfCheck(ctx: DshContext): void {
  ctx.inject(['settings'], (child) => {
    child.effect(() => {
      try {
        const settings = child.get<{
          describe(): Array<{ ns: string }>
          configure(presentation: { auto?: boolean }, owner: unknown): () => void
        }>('settings')
        if (settings === undefined) return
        const found = settings.describe().some(descriptor => descriptor.ns === ABILITY_NS)
        if (!found) {
          ctx.logger.warn(
            `[rune] settings namespace "${ABILITY_NS}" not found; the ability page cannot persist. `
            + `Check that cordis.patch.yml inserts this package with id "${ABILITY_NS}".`,
          )
        }
        return settings.configure({ auto: false }, ctx.fiber)
      } catch (error) {
        ctx.logger.warn(`[rune] settings self-check failed: ${String(error)}`)
      }
    }, 'dsh-magica-rune: settings self-check')
  })
}

/** 配置里的阈值收敛到 1..100（越界/非数字给 15）。 */
function seedNudge(value: number): number {
  if (!Number.isFinite(value)) return 15
  return Math.min(100, Math.max(1, Math.round(value)))
}

export function apply(ctx: DshContext, config: RuneConfig): void {
  const state = new GuardState()

  // 0) 可选：settings 自检 + 关掉自动表单
  installSettingsSelfCheck(ctx)

  // 0b) 内置 skill：注册到**全局层**（registerProvider，list 只给目录行、get 才读盘）。
  //     放在最前面：它与门禁无关，且失败只 warn，不影响下面任何一步。
  const builtinSkill = registerBuiltinSkill(ctx)

  // 1) 种子：先让 state 有名单与 gate，否则 guard 首调读到空集
  const bootstrap = readConfig(config)
  state.sync(bootstrap)
  state.nudgeEvery = seedNudge(bootstrap.nudge.everyToolCalls)

  // 2) 工作区索引（guard 依赖 agentWorkspace）
  const workspaceIndex = installWorkspaceIndex(ctx, state)

  // 3) 两个 advisory 通道：先建 handle，下面的 watch 闭包按引用读
  const skillGate = installSkillGate(ctx, state)
  const restrict = installRestrict(ctx, state)

  // 4) 主通道（全局层，权威）
  const guard = installGuard(ctx, state)

  // 5) 目录 HTTP
  const catalog = installCatalog(ctx, state)

  // 5a) 日志降噪：把指定 logger 的 info 压掉（warn/error 照旧）。
  const restoreQuiet = (() => {
    const names = readConfig(config).quietLogs
    try {
      return quietLoggers(ctx as unknown as { get: <T>(name: string) => T | undefined }, names)
    } catch (error) {
      ctx.logger.warn(`[rune] quiet logs failed: ${String(error)}`)
      return () => {}
    }
  })()

  // 5b) 「连续工具调用无文本输出」提醒：按 session 计数、子代理跳过。
  //     与门禁链路无关，装失败只 warn，不影响能力管理。
  // 选项用 getter：通用设置页改了 everyToolCalls 之后，下一次计数就用新值，不用重启。
  const nudgeOptions = (): NudgeOptions => {
    const value = readConfig(config).nudge
    return {
      plugin: name,
      section: 'rune-nudge',
      // 阈值读**内存值**：设置页点一下就能立刻改变下一次计数，不用等配置落盘。
      everyToolCalls: state.nudgeEvery,
      remindEvery: Math.max(1, state.nudgeEvery),
      skipSubagents: value.skipSubagents,
    }
  }
  if (readConfig(config).nudge.enabled) {
    try {
      installNudge(ctx as unknown as NudgeContext, nudgeOptions)
    } catch (error) {
      ctx.logger.warn(`[rune] nudge install failed: ${String(error)}`)
    }
  }

  // 6) 配置热更新：一条通道驱动全部重挂
  const watch = ctx.effect(() => ctx.on('loader/volatile-update', () => {
    try {
      state.sync(readConfig(config))
      restrict.refresh()
      skillGate.refresh()
    } catch (error) {
      ctx.logger.warn(`[rune] volatile update failed: ${String(error)}`)
    }
  }), 'dsh-magica-rune: config watch')

  // 7) 统一收口
  ctx.effect(() => () => {
    watch()
    catalog()
    guard()
    restrict.dispose()
    skillGate.dispose()
    workspaceIndex()
    builtinSkill()
  }, 'dsh-magica-rune: teardown')
}
