# PLAN：runtime command（issue 作为远程工具调用）

> 状态：**已实现 v1（默认 command tool 为 bash / pwsh）**。castboard 测试 **369/369** 通过，typecheck/build 通过。
> `urgency: 'runtime'` 的 issue 由目标 instance 认领后直接执行一次工具调用，
> 结果以 issue 评论返回；不建 task、不进看板、不起 agent 会话。

## 1. 语义与触发策略

`runtime` 不是优先级，而是一条独立执行路径：

| urgency | 含义 | 是否建卡 | 执行方式 |
|---|---|---|---|
| `runtime` | 目标 runtime 直接执行工具 | 否 | 目标 instance |
| `direct` | 跳过 router 规划 | 是 | dispatcher 正式会话 |
| `urgent` / `normal` / `relaxed` | 看板优先级 | 是 | dispatcher 队列 |

策略：只有用户明确要求“在某台 instance 上执行某个命令/工具”时才创建 runtime issue；
禁止主动用于重试、健康检查、同步或省 token。策略写入 system prompt、delegation help、
tool description 和错误文本。

## 2. 通用 runtime envelope

```text
assignerMeta.runtime = {
  tool?: string,        // 可选；省略 = 目标平台默认 command tool
  arguments: object     // 必填；按选中 tool 的 DSH schema 校验
}
```

- `runtime` 是通用工具调用通道，不是 bash 专用；
- 省略 `tool`：目标平台默认 command tool（Windows `pwsh` / Linux、macOS `bash`）；
- 显式 `tool`：供后续其他已实现 runtime tool 使用；
- `arguments` 的字段由选中 tool 决定。

### 默认 command tool 的 arguments

```text
command       string   required
description   string   required
workdir       string   optional absolute path
timeoutMs     integer  optional 1000..600000, default 120000
```

只支持前台执行；不支持 `run_in_background`、`sandbox_permissions`、`justification`。

## 3. 平台解析

**默认 command tool 只看 target 的 platform，和分发者无关。**

- 创建时通过 SDK `query.devices(assignee)` 按 `assigneeInstance` 找目标设备，读取 `os`；
- Windows → `pwsh`，Linux/macOS → `bash`；
- 宿主把解析出的默认 tool 写进 issue 的 `assignerMeta.runtime.tool`；
- 设备缺失、OS 未知或显式 tool 与目标 OS 不匹配 → 创建前 rejected；
- 目标 `RuntimeCommandWorker` 仍以自身 `process.platform` 为准，不信任分发端字段。

## 4. 参数校验

- 目标 worker 从 `ctx.tools.get(tool)?.parameters` 取真实 DSH schema；
- 但 DSH 的 shell 工具通常注册在 **agent scope**，全局 view 可能拿不到 schema；
- 因此 validator 增加保守 fallback schema：`command`、`description` 必填，
  `workdir`、`timeoutMs` 有界；
- 优先真实 schema，缺失时才 fallback；
- 手写 parser 还限制 command/description 长度、timeout 上限、workdir 绝对路径和额外参数。

## 5. cwd / permission / sandbox

- `cwd` 必须显式、绝对，且属于已注册 workspace；不自动注册；
- `permission` 必须显式：`read-only | workspace-write | danger-full-access`；
- 传给 shell 的 `sandboxPolicy` 为 `{ mode: permission, workspaceRoot: cwd }`；
- 受限 permission 要求 shell 有 sandbox，否则 spawn 前拒绝；
- 请求 permission 不得超过 shell 的 `sandboxMode` 上限；
- `sandbox.denied` 即使 exit 0 也判 failed，不自动重试。

## 6. 执行流程

```text
producer creates issue (runtime envelope)
  ├─ castboard_issues_create: parse { tool?, arguments }
  ├─ tool omitted -> SDK device.os -> default command tool
  ├─ explicit tool -> validate target OS / implemented list
  └─ unknown device/os/tool -> rejected before cloud write
  │
  ▼
target SyncService: pending -> accepted
  │
  ▼
RuntimeCommandWorker.tick()
  ├─ summary 过滤 urgency=runtime、status=pending/accepted、assigneeInstance=local
  ├─ 同账号检查；local CAS accepted/pending -> routing
  ├─ fire-and-forget：命令在后台执行，轮询不 await
  ├─ parse envelope；tool = requested ?? platformRuntimeTool()
  ├─ 参数 schema 校验 + workspace / permission preflight
  ├─ ctx.shell.resolve/execute/result
  ├─ 系统评论本地落盘 + 云端 publish（同一 commentId）
  ├─ 本地 status = success|failed；assigneeMeta.runtime = result
  └─ faces.finalize 回写云端
```

关键修复：router 的 `healStranded` 不再把 `urgency=runtime` 的 `routing` issue
复位为 `pending`；runtime issue 的 routing 状态由 RuntimeCommandWorker 独占，
直到它自己收尾。否则 router 每 3 秒复位一次，worker 每拍重复执行并重复评论。

## 7. 结果评论

- `runtime <tool>`、命令、outcome、exit code/signal、耗时；
- cwd、permission、sandbox mode；
- stdout/stderr（截断标记与 spill 路径）；
- 评论通过 `faces.comments.publish` 直发云端，本地/远端使用同一 id。
- **自动回传**：runtime 结果仍是 `role=assignee`、`authorType=system`、
  `systemKey=sys.runtimeCommand` 的 issue 评论；投递器把它当作 RPC 答案，
  允许唤醒 assigner 会话（同进程 push/steer/followUp，跨机由 inbox 投递）。
  云端评论没有 systemKey 时，用正文头 `runtime ` 识别；
  目标会话不在线则记 pending 欠账，之后补投。
- **远端可靠性**：comment publish / finalize 各重试一次；本地状态已经结算，失败只记录不推翻结果。
- **生命周期**：`dispose()` 会 abort 仍在执行的命令。

终态：

- exit 0 且未超时/abort/sandbox denied → `success`
- 非 0 / timeout / aborted / sandbox denied → `failed`
- 非法 payload、无 workspace、无 sandbox、跨账号拒绝 → `abandoned`

## 8. 安全边界

- 默认只允许 `assigner === assignee`；
- 跨账号需 `DSH_CASTBOARD_RUNTIME_ALLOW_CROSS_ACCOUNT=1`；
- 只允许当前平台 command tool 或已实现 runtime tool；
- 只前台执行；
- 整个 worker 可用 `DSH_CASTBOARD_RUNTIME=0` 关闭；
- 进程中断的 issue 标 failed，不自动重跑。

## 9. 代码落点

- `src/host/runtime-contract.ts`
  - 平台映射 `platformRuntimeTool` / `runtimeToolForOs`
  - 通用 schema、tool catalog、fallback command schema
- `src/host/pipeline/runtime-command.ts`
  - `RuntimeCommandSpec` / `RuntimeCommandRequest`、parser
  - `createToolArgsValidator`（真实 schema + fallback）
  - `createShellRuntimeExecutor`、评论/meta
- `src/host/pipeline/runtime-worker.ts`
  - `RuntimeCommandWorker`：认领、后台执行、评论、终态、恢复
- `src/host/pipeline/router.ts`
  - `isRoutable` 跳过 runtime
  - `healStranded` 跳过 runtime
- `src/host/tools/issue-tools.ts`
  - runtime 创建 schema / 错误契约
  - 用 SDK 设备 OS 解析默认 tool
- `src/host/context/delegation-context.ts`
  - field_map 的 runtime 子字段
  - 嵌套 `<tools><tool name=...><description/><arguments_schema/></tool></tools>`
- `src/index.ts`
  - 注入 shell、validator、comments、finalize

## 10. 测试

- 平台映射：win32 → pwsh；linux/darwin → bash；设备 OS → tool
- 创建：目标设备缺失/OS 未知 → rejected；已知 OS → host 填 tool
- worker：tick 不等待；最多 4 并发；`settled()` 收口
- parser：合法 arguments、缺失 runtime/permission、非法 command/timeout/workdir/额外参数
- validator：真实 schema；全局 registry 看不到 pwsh 时 fallback 仍校验 command/description
- shell executor：无 sandbox fail closed、permission 超限、workdir/policy
- worker：成功、非零、sandbox denied、非法 payload、instance 不匹配、workspace 校验、跨账号
- router：runtime 不进入 router；routing 中不被 healStranded 复位
- help：runtime 通用 envelope + 嵌套 tool 列表，不出现 bash 专用描述

## 11. 本轮不做

- 后台执行 / job 输出
- 交互式审批
- 执行结果附件上传
- 跨账号默认放行
- 看板展示 runtime 执行详情（issue 评论足够）
