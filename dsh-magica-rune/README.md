# dsh-magica-rune · 能力管理

给 DSH 装上「工具 / 技能」的总开关：**在设置里按需启用或禁用任意一个工具与技能，并且可以精确到某一个工作区。**

不喜欢的工具可以关掉，模型就看不见它、也调不动它；同一个工具还能做到「A 项目里禁用、B 项目里保留」。改动即时生效，不用重启 DSH，也不用改任何配置文件。

- 包名：`@meiyukichan/dsh-magica-rune`（设置命名空间仍是 `dsh-magica-rune`）
- 适用版本：DSH **0.2.0 ~ 0.2.1**（在 0.2.1-rc.5 实测；Web 端）
- 界面入口：**设置 → 能力管理**（在「内置插件」之后、「Agent 预设」之前，图标是扳手 + 螺丝刀）

---

## 一、它解决什么问题

DSH 的工具和技能是「一次装配、全会话可见」的。当工具越装越多（插件自带工具、MCP、子 Agent、后台 Job……），常见诉求有三种：

1. **关掉用不上的**：比如你从不让它跑 shell，就别让 `pwsh` 出现在工具清单里，白占上下文。
2. **按项目区分**：同一个 `read`/`write`，在 A 项目要放开、在敏感项目里想收紧。
3. **保留但临时停用**：先关掉，随时再打开，而不是卸载插件。

能力管理把这三件事做成一个页面，并且**同时管住两条链路**：

| 链路 | 效果 |
|---|---|
| 模型看到的工具清单 | 被禁的工具从 schema 里消失，不再消耗上下文 |
| 系统提示词 | 不再注入该工具的说明段落 |
| 运行时调用 | 万一模型仍按名字调用，直接拒绝并回一句 `ability: tool "xxx" is disabled by settings` |

技能侧同理：被禁的技能会从 `<available_skills>` 目录里移除，`skill` 调用也会被拒。

---

## 二、安装

```bash
# 装进某个 profile（示例用 web；也可用 dev 之类自建 profile）
dsh plugin --profile web add @meiyukichan/dsh-magica-rune
```

装好后**重启一次 dsh**（插件在启动期装配），然后打开 Web 界面 → 左下角「设置」→「能力管理」。

> 如果是从本地目录安装：`dsh plugin --profile web add D:\path\to\dsh-magica-rune`。

---

## 三、使用指南

### 3.1 页面结构

```
能力管理
├─ 工具 | 技能           ← 两个 tab，切换管理对象
├─ 搜索框                ← 同时过滤下面两个区
├─ 全局                  ← 默认展开：对所有会话生效
└─ 工作区                ← 默认折叠：只对选中的工作区生效
```

**全局区**是默认值；**工作区区**在该默认值之上叠加，可以「捞回」被全局禁用的项，也可以单独禁用某个工具——但**不能**捞回被标记为「内置禁用」的工具（见 §4）。

### 3.2 找到一个能力

顶部搜索框支持按**工具名**或**分类名**过滤，并且**一个框同时作用于全局区与工作区区**（不是各管一半）。清空即恢复全部。

### 3.3 启用 / 禁用

点击任一「药丸」即可切换。三种状态：

| 状态 | 外观 | 含义 |
|---|---|---|
| 启用 | 淡灰底 + 该分类颜色的描边 | 模型可用（默认） |
| 禁用 | 透明底 + 发丝灰描边 | 模型不可见、不可调用 |
| 内置禁用 | 半透明 + 虚线描边 + 「内置禁用」徽标 | 部署方指定的开箱即禁，**不可恢复**（默认没有，需在配置里声明） |

> **禁用 DSH 原生工具时会弹二次确认**（例如文件操作、Shell、子 Agent、Web、Workflow…）。因为这些是 DSH 自带能力，关掉可能影响正常对话。确认后才会写盘。「其它插件」类与自定义分类不弹确认。

### 3.4 分组批量

每个分组标题右侧有一个复选框：

- **不是全启用** → 一次**全部启用**
- **已经全启用** → 一次**全部禁用**

勾选框呈「半选」态表示该组部分启用、部分禁用。

### 3.5 按工作区配置

1. 展开「工作区」区（或直接点右侧下拉）；
2. 在下拉里选一个工作区（未选择时显示「未选择」；工作区很多时列表会在浮层内滚动）；
3. 该区的开关键**只影响落在该工作区的会话**。

工作区之间互不影响；工作区配置永远叠加在全局之上——所以「全局禁用 + 某工作区启用」是有效的，反过来「全局启用 + 某工作区禁用」也有效。

### 3.6 什么时候生效

- **新会话 / 新子 Agent**：创建那一刻就按最新配置装配，立即生效；
- **已经开着的会话**：**下一个回合**（下一次模型请求）生效；
- 全程**不需要重启 dsh**，也不需要重建会话。

---

## 四、内置保护（不可禁用）

有几个名字被**硬保护**，无法从页面禁用（也看不到开关）：

| 名字 | 为什么保护 |
|---|---|
| `run_code` | 它是 DSH 的 **PTC 呈现通道**，不是普通工具。禁用等于关掉整条工具调用通道；且 DSH 明确禁止对它做 restrict（会直接抛错） |

此外可由部署方在配置里追加保护名单（`nonDisableable` / `skillNonDisableable`，支持 `sandore_*` 这种前缀规则）。

---

## 五、配置（部署方 / 高级用户）

出厂默认写在包内的 `cordis.patch.yml`，只有三张名单：

```yaml
- insert:
    - id: dsh-magica-rune
      name: '@meiyukichan/dsh-magica-rune'
      config:
        # 开箱即禁（用户点不回来）
        builtinDisabled: []
        # 永不禁用；同时意味着页面不显示它
        nonDisableable:
          - run_code
          - 'sandore_*'        # 结尾 * = 前缀匹配
        # 技能侧永不禁用
        skillNonDisableable:
          - dsh-plugins-principles
          - sandore-workflow-authoring
          - cordis-plugin-development
          - editing-cordis-compositions
```

### 要改名单，别改这个文件

包内文件装好后位于 `node_modules` 下，升级会被覆盖。正确做法是往**自己 profile 的** `cordis.patch.yml` 写一条同 `id` 的覆盖行，并**完整重述** `config`（patch 层是整体替换，不深合并）：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml
- id: dsh-magica-rune
  name: '@meiyukichan/dsh-magica-rune'
  config:
    builtinDisabled: [web_search, web_fetch]
    nonDisableable: [run_code]
    skillNonDisableable: [dsh-plugins-principles]
```

> `id` 必须保持 `dsh-magica-rune`——它同时是设置项的命名空间，改了页面就读写不到配置。

**页面自己的开关状态不受影响**：它写在同一个 profile 的 patch 层里（`tools` / `skills` 两个字段），改名单不会把它们清掉。

---

## 六、注意事项

1. **`plugin_manager` 只影响对话**：禁用它，模型就不能再在对话里查询/启停插件；设置页的「内置插件」不受影响（那是另一条前端链路）。
2. **`skill` 慎禁**：DSH 的 skill catalog 会先检查 `skill` 工具是否可见，不可见时直接把目录置空（`packages/skill/tool-skill/src/index.ts:220-223`）——也就是**整个 `<available_skills>` 一起消失**，等于顺带把技能体系关了。只想关某几个技能，请到「技能」tab 逐项关。
3. **预设专属工具**：某些工具只存在于特定 Agent 预设（例如「创造模式」才有 `cordis_inspect_*`、`plugin_manager`）。这类工具需要**该预设至少开过一次会话**才会出现在页面上——页面按「全局层 + 当前存活会话」取并集；一旦出现过就会一直保留。
4. **页面显示的是可见性快照**：禁用后工具会从清单消失，即使后来又被重新注册，已记录的分类与说明也不会丢，便于你随时切回来。
5. **没有「保存」按钮**：每次点击即时写盘（乐观更新）。若写入失败（例如配置被上层覆盖层锁定），页面会静默重新拉取真实状态对账，不会弹提示。

---

## 七、兼容性

- 支持 DSH **0.2.0 ~ 0.2.1**；本机运行与源码均为 `0.2.1-rc.5`，已全量实测（typecheck / 单测 / E2E / 真机提醒）。
- peer 范围（`@deepseek-ai/dsh-*` 六个包一致）：

  ```text
  >=0.2.0-rc.2 <0.2.2-0 || >=0.2.1-rc.5 <0.2.2-0
  ```

  `0.2.1` 的 rc 预发布必须单独列一条（semver 的预发布规则：只写 `>=0.2.0-rc.2 <0.2.2-0` 会拒绝 `0.2.1-rc.x`）。
- **0.2.2 及以上未验证**：peer 会拒绝装配；确需试用可 `dsh plugin allow-version` 逐版本豁免。
- 仅 Web 平台（`dsh.client.platform: "web"`）。
- 中英文界面随 DSH 语言切换。

---

## 八、开发

```bash
pnpm install
pnpm build       # lib/index.js（host）+ lib/client.js（client），lib/ 不产出 sourcemap
pnpm test        # 69 个单测（node --test，无需额外框架）
pnpm typecheck   # tsc --noEmit
pnpm e2e         # 35 个端到端用例（Playwright，真开浏览器点页面）
```

### 端到端测试（E2E）

`e2e/` 是一套会**真的点页面**的用例（视觉数值、开关落盘、两级作用域、搜索、技能与目录接口），
共 35 个断言，约 30 秒跑完。

```bash
pnpm e2e                                          # 自动找空闲端口起 dev 实例跑
DSH_E2E_URL=http://127.0.0.1:3082/?token=... pnpm e2e   # 复用已跑着的实例
DSH_E2E_PROFILE=dev pnpm e2e                      # 指定 profile（默认 dev）
DSH_E2E_CHROMIUM=/path/to/chrome pnpm e2e         # 指定浏览器
DSH_E2E_ONLY=toggle,search pnpm e2e               # 只跑某几个 spec
```

**改完按「改动范围」选 spec，不必全量**：

| 改动 | 跑哪些 |
|---|---|
| `src/client/styles.ts`、`parts.tsx`、`tabs.tsx`（视觉/交互） | `style,toggle` |
| 搜索相关（`matchesRow`、搜索行位置） | `search` |
| 两级作用域、`state.ts` 的 `denied` | `scope` |
| 目录接口 `catalog.ts`、内置 skill、i18n 分类键 | `skills`（+ `style` 的分组标题断言） |
| 写入链路（`controller.ts` 的 revision/重试） | `toggle,scope` |
| `e2e/harness.mjs`、`run.mjs`（共享层） | **全量**（影响所有 spec） |
| 只改文档 / README | 不用跑 |

前提与约定：

- **目标 profile 里必须已装好本插件**（`dsh plugin --profile dev add <本目录>`），E2E 不改依赖；
- Chromium：优先 `DSH_E2E_CHROMIUM`，其次 playwright 自己登记的版本，最后扫 `%LOCALAPPDATA%/ms-playwright`。
  本仓 `pnpm-workspace.yaml` 把 `playwright` 的安装脚本列进白名单之外（不下载浏览器），
  所以要么复用系统里已有的 Chromium，要么手动 `pnpm exec playwright install chromium`；
- **隔离**：E2E 会真的改 `profiles/<profile>/cordis.patch.yml`。`e2e/run.mjs` 在开跑前快照、
  结束后原样写回（spec 内部不再动文件——中途改写会让 loader 换 revision，撞上乐观锁）。

设计文档（含 0.2 API 审计、逐条视觉规格、验证清单）：[`docs/README.zh.md`](docs/README.zh.md)。

目录速览：

```
src/
  index.ts         host 入口：name / inject / Config / apply
  policy.ts        名单匹配 + 生效集折叠（纯函数）
  state.ts         热路径唯一数据源
  guard.ts         主通道：tools.guard（权威拒绝）
  restrict.ts      辅通道：agent scope 上 restrict + assemble 过滤
  skill-gate.ts    agent 层同名 skill 遮蔽
  catalog.ts       GET /rune-ability/catalog（供页面取目录）
  shared/          纯数据层与 dsh 结构性类型
  client/          apply / store / controller / 组件 / 样式 / i18n / 导航图标
```

> 样式是「TS 字符串 + 注入 `<style>`」（esbuild 不做 CSS Modules），数值逐条对齐 `docs/raw/a.md` §5；只有 6px / 5px 圆角保留字面值，因为 0.2 的圆角 token 只有 4/8/12/16/20/28。

## 许可

[MIT](LICENSE)

