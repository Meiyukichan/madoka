# dsh-magica-spellbook · 文档

面向 **DSH 0.2.1-rc.5** 的插件 SDK（安装范围 `0.2.0 ~ 0.2.2`）。本包**已落地实现**（`src/` 34 文件 / 6 188 行，`tests/` 266 例全绿），命令见包根 `README.md`。

| 命令 | 作用 |
|---|---|
| `pnpm typecheck` | host + client 全量类型检查 |
| `pnpm test` | `node --test --test-isolation=none`（102 例） |
| `pnpm build` | `lib/index.js` + `lib/client.js`（压缩）+ `lib/types/**` |
| `pnpm verify` | 产物契约六条断言 |

## 设计文档（唯一权威）

| 文档 | 内容 | 规模 |
|---|---|---|
| [`design/00-overview.zh.md`](design/00-overview.zh.md) | **总纲**：模块总览与计数、包/产物契约、依赖矩阵、**0.2.0-rc.2 适配矩阵**、横切规则、测试与落地顺序、风险登记册 | 4 个一级模块 / 18 个二级模块 |
| [`design/01-core-utils.zh.md`](design/01-core-utils.zh.md) | 核心工具层：`event-log` / `field-crypto` / `http-route` / `proxy-fetch` / `pricing` | 5 模块 / ~1 582 行基线 |
| [`design/02-sessions.zh.md`](design/02-sessions.zh.md) | 会话运行内核：结局判定、台账、两个门面、审批/提问接管、workspace 登记 | 8 文件 / 5 046 行基线 |
| [`design/03-interactions.zh.md`](design/03-interactions.zh.md) | 待决交互：host HTTP 面 + 线上契约 + 浏览器侧卡片与接管装配 | 4 文件 / 633 行 + 9 文件客户端 |
| [`design/04-client.zh.md`](design/04-client.zh.md) | 浏览器侧目录选择器（`DirectoryBrowser`）及其 raw-TSX 产物契约 | 892 + 404 行基线 |

## 一致性核对（素材 → 实现，逐条）

`docs/raw/` 的素材已按文件拆成可断言需求清单，再逐条对照实现核对；**这是"设计是否被完整实现"的权威依据**：

| 文档 | 覆盖素材 | 条目 | 结论 |
|---|---|---|---|
| [`design/05-conformance-core-utils.md`](design/05-conformance-core-utils.md) | `c.md` | 208 | 199 一致 / 6 差异 / 0 缺失 |
| [`design/05-conformance-interactions.md`](design/05-conformance-interactions.md) | `d.md` + `e.md` | 278 | 244 一致 / 28 差异 / 1 缺失（含 2 条安全债） |
| [`design/05-conformance-sessions-a.md`](design/05-conformance-sessions-a.md) | `i.md` + `j.md` | 139 | 121 一致 / 9 差异 / 1 缺失 |
| [`design/05-conformance-sessions-b.md`](design/05-conformance-sessions-b.md) | `k/l/m.md` | 487 | 221 一致 / 74 差异 / **186 缺失**（多为待补测试断言） |
| [`design/05-conformance-client.md`](design/05-conformance-client.md) | `a.md` + `b.md` | 616 | 383 一致 / 156 差异 / 61 缺失 |

需求清单原件在 `.e2e/audit/G1…G5*.md`（只读素材，供复核）。

## 素材（`docs/raw/`，只读）

`raw/a.md`–`raw/o.md` 共 **15 篇 / 10 759 行**，是对 0.1.6-rc.26 版 `@amazing-tools/dsh-magica` 的实现剖析，作为本设计的**事实基线**。它们的文档分片关系：

| 素材 | 覆盖 | 归入 |
|---|---|---|
| `a.md` + `b.md` | `src/client/**`（同一份文档的上下片） | `04-client`、`03-interactions` |
| `c.md` | `event-log` / `field-crypto` / `http-route` / `proxy-fetch` | `01-core-utils` |
| `d.md` + `e.md` | `src/interactions/**` | `03-interactions` |
| `i.md` + `j.md` + `k.md` + `l.md` + `m.md` | `src/sessions/**`（同一份文档的 5 个连续分片） | `02-sessions` |
| `n.md` + `o.md` | `src/link/**` + `src/issue/**` + `src/task/**`（Issue⇄Task⇄Session 评论通道） | **不在本包**，随 lattice / teamwork |
| `f.md` + `g.md` + `h.md` | `src/lattice/**` | **按指令忽略** |

## 三条读法提醒

1. **素材是 0.1.6 的事实，0.2 的写法以 `design/` 为准**。两者冲突时看 `design/00-overview.zh.md` §5 的适配矩阵（标 ❗ 的项照抄会静默失效）。
2. **素材里的行号只对 0.1.6 源码成立**，不要拿去对 0.2 的 dsh 源码（0.2 的坐标已逐条写进设计文档并核对）。
3. **`n.md`/`o.md` 虽在本目录，但不属于本包**：它们是 lattice 侧评论通道的定稿设计，只是因为依赖了 `sessions` 门面的三个坑（K1/K2/K3）才被一起收集。
