# dsh-magica-castboard

DSH 0.2 的**协同插件**：任务台账 + 看板 + 派活中枢。

- **host 半侧**：任务/issue 台账（租约单写者）、执行编排（会话走 [`dsh-magica-spellbook`](../dsh-magica-spellbook)）、
  cron 调度与派发、4 个能力网关工具、`/api/castboard` HTTP 面。
- **client 半侧**：把「协作」面板注册进 dsh web（`sidebar.panellist` 入口 + `main` 整页）；
  会话能力不自己实现，共享库数据走 [`dsh-magica-teamwork`](../dsh-magica-teamwork) 的 SDK。

方案与设计：

| 文档 | 内容 |
|---|---|
| [`docs/README.zh.md`](docs/README.zh.md) | 多人 / 多实例 / 多目标系统协同方案（给使用者与评审） |
| [`docs/design/01-merged-plugin-design.zh.md`](docs/design/01-merged-plugin-design.zh.md) | 合并插件设计：包边界、组件契约、注册点、数据通道、迁移与裁剪 |
| [`docs/CONTEXT-INJECTIONS.md`](docs/CONTEXT-INJECTIONS.md) | 全部上下文注入、系统提示、用户指令与动态模板清单 |

## 快速开始

```bash
pnpm install
pnpm build          # → lib/index.js（host）+ lib/client.js（client 闭包工厂）
pnpm test           # 单测：产物形状 / 字典 / 解析
pnpm e2e            # 假 shell 渲染验收（Playwright + 真实产物，浅深两套截图）
pnpm e2e:dsh        # 真 dsh E2E：工作区内隔离 DSH_HOME，装插件、开面板、切 tab、截图
pnpm e2e:accept     # 真机协议面验收：隔离 DSH_HOME 起真 dsh，跑 /api/castboard 全流程 + 工具注册 + 产物分发
```

> `pnpm e2e` / `pnpm e2e:dsh` 需要能起浏览器；在**受限沙箱**里 Chromium 的命名管道会被拒（EPERM），
> 此时用 `pnpm e2e:accept`——它不依赖浏览器，验的是面板与真机之间的那层 HTTP 契约。

> `pnpm e2e:dsh` 用的是本包下的 `.e2e/home` 这个**工作区内**的 profile，不会碰 `~/.dsh`。
> 首次启动 dsh 会弹「预览版说明 / API Key」模态，E2E 会自动点掉。

## 装进自己的 profile

```bash
dsh plugin --profile <name> add link:<path-to-this-package>
```

`cordis.patch.yml` 里是**裸包名那一行**（只有这一行会挂载 `./client`）。
peer 版本必须落在 `>=0.2.0-rc.2 <0.3.0-0 || >=0.2.1-rc.5 <0.3.0-0 || >=0.2.2-rc.1 <0.3.0-0`，否则 profile 组合期该行会被直接禁用。本包的 `devDependencies` 钉在 `0.2.1-rc.5`（cordis `4.0.5`、schemastery `3.18.5`）作为编译与测试基线；不写 `engines.dsh`，让校验真正落到每个逐包 peer 上。

## 当前进度

| 里程碑 | 状态 |
|---|---|
| M0 包骨架与 0.2 对齐（slot 注册、构建、locale、样式、E2E） | ✅ 假 shell 20/20、真 dsh 23/23 |
| M1 台账与租约 | ✅ 三本台账 + 原子写 + 租约（含 pid 判死）+ 双机剧本 |
| M2 HTTP 面（`/castboard` 全套 + `/state` 四游标） | ✅ 45 条端点，真实 server 矩阵测试 |
| M3 工具面 | ✅ 20/20（10 任务 + 10 issue；共享库查询缺 SDK 面时降级为 `degraded`） |
| M4 会话与执行（spellbook 门面） | ✅ 执行引擎 + 会话适配 + 待决交互 |
| M5 调度与派发 | ✅ 调度器 + 派发器 + cron 解析（8 例单测） |
| M6 issue 流水线 | ✅ 合并/认领/依赖/收尾/直通/router（真临时会话）/评论双向/导入导出/验收轮 |
| M7 teamwork 组件库 | ✅ 14 组件 + 看板页 + 13 分区详情 + model 层（151 例） |
| M8 合并面板 | ✅ 看板/议题/设置三 tab，接 `/state` 四游标 |
| M9 饱和验收 | ✅ 端点矩阵 + 双机剧本 + 装卸 3 轮 + Playwright 截图 |
| M10 画像 | ✅ 批次窗口/退避/上限 + runner 真写文件（`worklabs/workspaces/<id>.md`） |
| M11 产物上行 | ✅ `ArtifactUplink`：结算后自动传、先挂再记幂等、每批 10 个 / 50MB / 0 字节跳过 |

## 运行时闭环（都已接线并有测试）

- **派活**：`SyncService` 拉本机名下 pending issue → 认领仲裁 → 合并；`RouterService` 用**临时会话**规划成卡（`startDetached`），失败退避 `n×60s`、3 次转 `abandoned`；`direct` 卡跳过规划直接建卡；
- **执行**：`ExecutionService` 起正式会话（spellbook），结算后走 `onSettled`；
- **验收**：`AcceptanceRunner` 打 `acceptanceInjectedAt` 后起 assist 轮，起不来会回滚簿记；
- **产物**：`onSettled` 读 `execution_report` 的 `artifacts` → `ArtifactUplink` 上传（幂等表在发布游标里）；
- **评论**：`ThreadService` 单一入口 → 出版器上云 → `Deliverer` 三档投递（活会话直推走 `execution.followUpSession`）；
- **画像**：`PortraitRunner` 每天 03:00 / 13:00 两批，写文件成功才算数。

## 目录

```
src/
├── index.ts            host 插件入口（name / inject / apply）
├── host/               台账、执行、调度、工具、路由、流水线
├── client/
│   ├── index.ts        client 入口：slot 注册 + locale + 样式
│   ├── locale.ts       zh/en 字典（键集必须一致）
│   └── panel/          面板壳（M0 骨架，M8 换成真数据）
├── shared/             线格式与请求/响应类型
scripts/                build / typecheck / clean / deps（工具链解析）
e2e/                    render.mjs（假 shell）、real-dsh.mjs（真 dsh）、acceptance.mjs（真机协议面）、artifacts/
tests/                  单测（node --test + 原生 TS 剥离）
```
