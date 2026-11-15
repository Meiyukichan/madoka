# dsh-magica-rune 设计文档

> **一句话**：把「能力管理」收敛为 **tool 与 skill 两类能力**（启用/禁用，精确到工作区），全部落在 DSH `0.2.0-rc.2` 的原生挂载点与原生组件上；**前端视觉与交互以下文 `03` 篇的数值规格为唯一依据**。

> **范围限定**：能力管理天然覆盖「工具 / 技能 / 命令 / Agent」四类。**本方案只做「工具」与「技能」**。
> 命令与 Agent 两类在 0.2 没有可用的拦截挂载点（详见 [`design/01-dsh02-audit.zh.md`](design/01-dsh02-audit.zh.md) §4.5），结论保留在该篇里作为「已评估、不做」的存档，**代码、配置、UI、文案、测试中一律不出现**。

## 文档地图

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [`design/00-overview.zh.md`](design/00-overview.zh.md) | 目标、设计前提与取舍原则、**两类能力的可行性结论**、总体架构、方案有效性结论 | 先看这一篇 |
| [`design/01-dsh02-audit.zh.md`](design/01-dsh02-audit.zh.md) | **API 逐项核对与设计依据**：22 项「一页结论」+ host（`settings` / `tools` / `systemPrompt` / `workspaceRegistry` / `agents` / `skills` / `webServer` / 事件 / cwd）+ client（slot / locale / remote / 原语 / token / 几何）+ 包工程（`dsh` 声明 / peer / patch / bundle / sourcemap），每项给「设计假设 → 0.2 实际 → 判定 → 源码证据 → 替换代码」 | 想知道「每个 API 在 0.2 到底怎么用、依据是什么」 |
| [`design/02-host-ability-gate.zh.md`](design/02-host-ability-gate.zh.md) | host 半侧详细设计：配置层（`Config` + `Volatile`）、policy 合并语义、`GuardState`、工作区索引、`tools.guard`、`tools.restrict`、skill 运行时遮蔽、catalog HTTP、生命周期与错误处理 | 写 host 代码时 |
| [`design/03-client-ability-ui.zh.md`](design/03-client-ability-ui.zh.md) | client 半侧详细设计：注入契约、`settings.section` 注册、`defineStore` + controller、组件树、**CSS 全量清单**、token 真名映射、原语替换裁决、导航图标 hack、i18n、逐条交互规格 | 写前端时；**视觉保真的唯一依据** |
| [`design/04-package-and-verification.zh.md`](design/04-package-and-verification.zh.md) | 包工程（`package.json` 全文 / `cordis.patch.yml` / 构建产物契约 / peer 兼容）、测试计划、验证矩阵、验收清单、风险与回退 | 落地与验收时 |
| [`design/05-skill-compliance.zh.md`](design/05-skill-compliance.zh.md) | **对照内置 skill `dsh-plugins-principles` 的逐条合规审查**：7 类规则的结论与证据、审查中修掉的 4 个问题、仍存在的偏差（含理由与合规化路径） | 交付前自查 / 换人接手时 |

## 设计文档的组织方式

六篇文档按「结论 → 依据 → 实现 → 交付」分层，彼此只通过 §号 交叉引用；**每一篇的数值、API 名与签名都以 DSH `0.2.0-rc.2` 的源码与运行时行为为准**，正文中出现的 `packages/…` 行号引用即出处，可逐条回溯。

| 层次 | 文档 | 承载的内容 |
|---|---|---|
| 结论层 | `00-overview.zh.md` | 做什么、不做什么、为什么可行 |
| 依据层 | `01-dsh02-audit.zh.md` | 每个 API 在 0.2 的事实、源码行号与替换写法 |
| 实现层 | `02-host-ability-gate.zh.md`、`03-client-ability-ui.zh.md` | host 与 client 的完整规格（含全部 CSS 数值） |
| 交付层 | `04-package-and-verification.zh.md`、`05-skill-compliance.zh.md` | 产物契约、验收矩阵与合规自查 |

## 三条硬约束

1. **不改 agent loop**。所有动作都是 DSH 已有挂载点上的**增量注册**（`tools.guard` / `tools.restrict` / `agent/created` 观察 / `agentCtx.skills.register` / `system-prompt/assemble`），不改 session → agent → loop → assemble → execute 的任何一环。
2. **前端视觉不变**。颜色、字号、圆角、间距、token 名等视觉规格集中定义在 [`design/03-client-ability-ui.zh.md`](design/03-client-ability-ui.zh.md) §5 的数值表与 §6 的 token 映射表里，数值本身不做任何改写；只有「0.2 不存在的 token」按 §6 的映射表替换，替换项逐条列出理由。
3. **只用 public API**。不 import 任何插件的运行时值，跨插件协作只走 Cordis service / slot；client bundle 通过 purity gate。

## 判定速览（详见 `01`）

| 维度 | 设计假设在 0.2.0-rc.2 的实际情况 |
|---|---|
| tool 双通道（guard + restrict + assemble 过滤） | ✅ **完全成立**，签名与语义一致；`restrict` 的 own-layer 豁免只作用于注册它的那一层，所以 preset 挂到 agent 平面的工具**能被 restrict 移除**（粒度比手写黑名单更细） |
| skill 运行时遮蔽（同名 `invocation:false`） | ✅ **完全成立**，`SkillInvocationPolicy` / `isModelInvocable` / `isUserInvocable` / `<available_skills>` 过滤 / `skills/change` 语义完全一致；**但必须注册进 agent scope 层**，否则 project 级同名 skill 会静默逃逸 |
| 配置持久化 `settings.register(ns, schema)` + `scope.watch` | ❌ **不成立**。0.2 的 `settings` service 不提供 namespace 注册，配置一律来自「Loader entry 的 Config」：用 `Config` + `Volatile<T>` + `loader/volatile-update`，读写路径仍可走 `remote.settings` |
| 工作区解析 `realpathSync` + `workspaceRegistry.list()` 手比对 | ⚠️ **可用但不必**。0.2 原生就有 `workspaceRegistry.resolveByPath()`（async），本包在其上封装了 `findWorkspace()`，直接复用即可 |
| 前端 `settings.section` 注入 / `locale` / `remote.settings` / 事件推送 | ✅ **全部可用**；组件内部按 0.2 规约实现（`defineStore`、文本样式注入、不自订阅 locale） |
| 前端视觉 token | ⚠️ **25 个 token 全部存在**，但 `brand-primary` 在 0.2 的语义是「近黑/近白」而非「品牌蓝」，品牌色场景必须改用 `state-business-primary`；另有 3 处圆角/token 需按映射表替换 |
| 命令 / Agent 两类 | ⛔ **不在范围内**。0.2 没有命令级门禁挂载点；`named_subagent` 工具也不存在。评估结论存档在 `01` §4.5，**不实现** |
