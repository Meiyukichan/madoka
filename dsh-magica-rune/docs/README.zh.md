# dsh-magica-rune 设计文档

> **一句话**：把 0.1.2 时代的「能力管理」方案，**只保留 tool 与 skill 两类能力**（启用/禁用，精确到工作区），**只替换过时的 DSH 组件与 API**，重写为 DSH `0.2.0-rc.2` 的原生插件；**前端视觉与交互与 `docs/raw/` 原始设计一字不差**。

> **范围限定**：原始设计有「工具 / 技能 / 命令 / Agent」四个 tab。**本方案只做「工具」与「技能」**。
> 命令与 Agent 两类在 0.2 没有可用的拦截挂载点（详见 [`design/01-dsh02-audit.zh.md`](design/01-dsh02-audit.zh.md) §4.5），结论保留在审计文档里作为「已评估、不做」的存档，**代码、配置、UI、文案、测试中一律不出现**。

## 文档地图

| 文档 | 内容 | 什么时候看 |
|---|---|---|
| [`design/00-overview.zh.md`](design/00-overview.zh.md) | 目标、与 `raw/` 的关系、**两类能力的可行性结论**、总体架构、方案有效性结论 | 先看这一篇 |
| [`design/01-dsh02-audit.zh.md`](design/01-dsh02-audit.zh.md) | **逐项过时审计**：22 项「一页结论」+ host（`settings` / `tools` / `systemPrompt` / `workspaceRegistry` / `agents` / `skills` / `webServer` / 事件 / cwd）+ client（slot / locale / remote / 原语 / token / 几何）+ 包工程（`dsh` 声明 / peer / patch / bundle / sourcemap），每项给「0.1.2 写法 → 0.2 现实 → 判定 → 源码证据 → 替换代码」 | 想知道「哪些过时了、为什么」 |
| [`design/02-host-ability-gate.zh.md`](design/02-host-ability-gate.zh.md) | host 半侧详细设计：配置层（`Config` + `Volatile`）、policy 合并语义、`GuardState`、工作区索引、`tools.guard`、`tools.restrict`、skill 运行时遮蔽、catalog HTTP、生命周期与错误处理 | 写 host 代码时 |
| [`design/03-client-ability-ui.zh.md`](design/03-client-ability-ui.zh.md) | client 半侧详细设计：注入契约、`settings.section` 注册、`defineStore` + controller、组件树、**CSS 全量清单**、token 真名映射、原语替换裁决、导航图标 hack、i18n、逐条交互规格 | 写前端时；**视觉保真的唯一依据** |
| [`design/04-package-and-verification.zh.md`](design/04-package-and-verification.zh.md) | 包工程（`package.json` 全文 / `cordis.patch.yml` / 构建产物契约 / peer 兼容）、测试计划、验证矩阵、验收清单、风险与回退 | 落地与验收时 |
| [`design/05-skill-compliance.zh.md`](design/05-skill-compliance.zh.md) | **对照内置 skill `dsh-plugins-principles` 的逐条合规审查**：7 类规则的结论与证据、审查中修掉的 3 个问题、仍存在的 3 处有意偏差（含理由与合规化路径） | 交付前自查 / 换人接手时 |

## 原始设计文档（只读，不改）

`docs/raw/` 是 0.1.2 时代的原始设计，**保留原样作为对照基线**：

| 文件 | 原内容 | 在本方案中的角色 |
|---|---|---|
| [`raw/dsh-tool-ability.md`](raw/dsh-tool-ability.md) | tool 侧实现说明（含 §1「所依赖的 DSH 组件和包」、§2 工作区链路、§3 不破坏 agent loop） | host 语义基线，API 全部按 `01-dsh02-audit.zh.md` 替换 |
| [`raw/dsh-skill-ability.md`](raw/dsh-skill-ability.md) | skill 侧实现说明（runtime 遮蔽 + 热加载链路） | host skill 语义基线，**0.2 下几乎原样成立** |
| [`raw/a.md`](raw/a.md) | 前端实现规格（视觉基线 7 条、CSS 全量、分类配色、组件结构、交互规格） | **前端视觉保真的唯一依据**，逐值照抄（只做前两个 tab） |
| [`raw/b.md`](raw/b.md) | 主题适配要点、已知瑕疵、逆向 checklist、静态 HTML 骨架 | 与 a.md 同 |

## 三条硬约束

1. **不改 agent loop**。所有动作都是 DSH 已有挂载点上的**增量注册**（`tools.guard` / `tools.restrict` / `agent/created` 观察 / `agentCtx.skills.register` / `system-prompt/assemble`），不改 session → agent → loop → assemble → execute 的任何一环。
2. **前端视觉不变**。`raw/a.md` §5 的 CSS 值全部照抄；只有「0.2 已不存在的值」按 `03-client-ability-ui.zh.md` §6 的映射表替换，替换项逐条列出理由。
3. **只用 public API**。不 import 任何插件的运行时值，跨插件协作只走 Cordis service / slot；client bundle 通过 purity gate。

## 判定速览（详见 `01`）

| 维度 | 0.1.2 方案在 0.2.0-rc.2 的可用性 |
|---|---|
| tool 双通道（guard + restrict + assemble 过滤） | ✅ **完全成立**，签名与语义一致；`restrict` 的 own-layer 豁免在 0.2 变成「只豁免自己那一层」，preset 挂到 agent 平面的工具**现在能被 restrict 移除**（比 0.1.2 更强） |
| skill 运行时遮蔽（同名 `invocation:false`） | ✅ **完全成立**，`SkillInvocationPolicy` / `isModelInvocable` / `isUserInvocable` / `<available_skills>` 过滤 / `skills/change` 全部未变；**但必须注册进 agent scope 层**，否则 project 级同名 skill 会静默逃逸 |
| 配置持久化 `settings.register(ns, schema)` + `scope.watch` | ❌ **过时**。0.2 的 `settings` service 不再提供 namespace 注册，改为「Loader entry 的 Config」。替换为 `Config` + `Volatile<T>` + `loader/volatile-update`（读写路径仍可走 `remote.settings`） |
| 工作区解析 `realpathSync` + `workspaceRegistry.list()` 手比对 | ⚠️ **可用但应替换**。0.2 原生有 `workspaceRegistry.resolveByPath()`（async），本仓 SDK `dsh-magica-spellbook` 的 `findWorkspace()` 已封装 |
| 前端 `settings.section` 注入 / `locale` / `remote.settings` / 事件推送 | ✅ **注册方式一致**；组件内部需按 0.2 规约改写（`defineStore`、CSS Modules、不自订阅 locale） |
| 前端视觉 token | ⚠️ **25 个 token 全部存在**，但 `brand-primary` 的语义在 0.2 从「品牌蓝」变成「近黑/近白」，必须换 `state-business-primary`；另有 3 处圆角/token 需按映射表替换 |
| 命令 / Agent 两类 | ⛔ **移出范围**。0.2 无命令级门禁挂载点；`named_subagent` 工具已不存在。评估结论存档在 `01` §4.5，**不实现** |
