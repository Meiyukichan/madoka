# madoka

DSH 0.2 插件集合。所有 0.2 包统一以 **DSH `0.2.1-rc.5`** 为编译/测试基线，peer 范围覆盖 **0.2.0 ~ 0.2.2**（保证安装；0.2.0 / 0.2.2 尚未做全量 API 回归）。

| 包 | 作用 |
|---|---|
| [`dsh-magica-rune`](dsh-magica-rune/) | 能力管理插件：按全局 / 工作区启用或禁用工具与技能 |
| [`dsh-magica-castboard`](dsh-magica-castboard/) | 任务台账 + 看板 + 派活中枢 |
| [`dsh-magica-teamwork`](dsh-magica-teamwork/) | 本地协作服务（issue / 项目 / 设备 / 文件）+ 客户端 SDK |
| [`dsh-magica-spellbook`](dsh-magica-spellbook/) | 0.2 插件 SDK（纯库，不是插件） |

![能力管理](dsh-magica-rune/assets/screenshot-1.png)

## 安装 rune

```bash
dsh plugin --profile web add @meiyukichan/dsh-magica-rune
```

装好后重启 `dsh web`，在 **设置 → 能力管理** 里就能看到开关面板。

## 它做什么

- 被禁用的工具会从模型的**工具清单**和**系统提示词**里同时消失，调用时再兜底拒绝；
- 被禁用的技能不再出现在技能目录里；
- 支持两级作用域（全局 / 单个工作区）、搜索、按分类分组批量开关；
- 内置保护项（如 `run_code`）不可禁用；
- 改动即时生效，不需要重启。

细节见 [插件说明](dsh-magica-rune/README.md)，设计与审计见[设计文档](dsh-magica-rune/docs/README.zh.md)。

## 开发

```bash
cd dsh-magica-rune
pnpm install
pnpm build        # 产出 lib/index.js（host）与 lib/client.js（client）
pnpm test         # 单元测试
pnpm typecheck
pnpm e2e          # 端到端（Playwright，真开浏览器点页面）
```

## 许可

[MIT](LICENSE)
