# 01 · 核心工具层设计（event-log / field-crypto / http-route / proxy-fetch / pricing）

> 一级模块：**core-utils**。0.1.6 基线：`src/event-log.ts` 280 行、`src/field-crypto.ts` 247 行、`src/http-route.ts` 603 行、`src/proxy-fetch.ts` 288 行、`src/pricing.ts` 164 行 + `token-price.json`（合计约 1 582 行）。
> 共同特征：**纯 host 侧（Node）、零 `@deepseek-ai/*` 运行时依赖、零 `ctx` 接收、零样式**。它们是 spellbook 里唯一"可以脱离 dsh 单独跑"的部分，也是最先能落地的部分（P0）。
> 0.2 适配结论：**这 5 个模块与 0.2 的 API 变更无关**（不碰 dsh 包），只需按 §6 重跑一次安全审视。

## 0.0 文件命名（已落地）

本文沿用 0.1.6 的模块名叙述，实现文件已按"短名单词"重命名：

| 本文 / 0.1.6 | 实现文件 | 说明 |
|---|---|---|
| `event-log` | `src/core/logger.ts` | 导出名不变（`createEventLogger` / `sanitize` / `EventLogger` / `LogLevel`） |
| `field-crypto` | `src/core/crypto.ts` | 导出名不变（`createFieldCrypto` / `FieldCryptoHandle` …） |
| `http-route` | `src/core/router.ts` | 导出名不变（`createJsonRouter` / `jsonRoute` / `sendJson` …） |
| `proxy-fetch` | `src/core/net.ts` | 导出名不变（`createProxyFetch` / `createLimitedFetch`）；**不再有 `./proxy-fetch` 子路径**，统一从主入口出 |
| `pricing` + `prices.json` | `src/core/pricing.ts` | 定价表改成常量内联（单文件产物不能靠旁路 JSON 资产） |

测试：`tests/core/{logger,crypto,router,pricing}.test.ts`（共 33 例）。

---

## 0. 速览与边界

| 模块 | 0.1.6 行数 | 实现行数 | 职责 | 入口 | 依赖 |
|---|---|---|---|---|---|
| `logger`（原 `event-log`） | 280 | ~270 | 脱敏诊断日志：内存环形缓冲 + 周轮转 NDJSON + bug 报告导出 | 主入口 | `node:fs`、`node:fs/promises`、`node:path`、`node:os` |
| `crypto`（原 `field-crypto`） | 247 | ~240 | 单字段加解密：Windows DPAPI / 其他平台 AES-256-GCM | 主入口 | `node:crypto`、`node:module`（惰性 `@primno/dpapi`） |
| `router`（原 `http-route`） | 603 | ~430 | 进站 HTTP 路由助手：响应写入、同源围栏、读体、query、两级包装器 | 主入口 | `node:http`（**仅类型**） |
| `net`（原 `proxy-fetch`） | 288 | ~210 | 内网出站：scoped TLS + 代理感知 + 超时 + 并发限制 | 主入口（`undici` external + `createRequire` 惰性） | `undici` + `node:https` |
| `pricing` | 164 | ~140 | token 货币定价表 + 一步账单（表内联，无旁路 JSON） | 主入口 | `node:fs`（仅自定义表路径时读盘） |

**四条共同不变量**（0.1.6 已固化，必须继承）：

| 编号 | 不变量 | 落地 |
|---|---|---|
| CU-1 | 热路径不同步写盘：日志走 5 s / 50 条异步 flush | `logger` 的 `pendingLines` + `flushPending()` |
| CU-2 | 写盘失败**一次即停用**持久化（不再重试、不再刷屏） | `persistenceEnabled = false` 单向熔断 |
| CU-3 | 写响应前必判 `headersSent`；闸门只抛 `HttpRouteError` | `router` 的 `sendResponse()` 是唯一写响应点 |
| CU-4 | TLS 绕过限定在**专用 Agent**，绝不设 `NODE_TLS_REJECT_UNAUTHORIZED` | `net` 的 `insecureAgent` / `insecureHttpsAgent` |

---

## 1. `logger`（0.1.6 的 `event-log`）—— 脱敏诊断日志

> **日志落点契约（0.2 真机校准）**
>
> 1. 目录名必须是**单段包名**：`$DSH_HOME/logs/dsh-magica-spellbook/log-<周一>.ndjson`。
>    名字里带 `/` 会把 `join(logs, name)` 拼成嵌套目录（真机事故：出现过 `logs/dsh-magica-spellbook/questions/`）。
>    现在 `createEventLogger` 对含分隔符的名字**直接抛错**；不同来源靠 `event` 字段区分（`question.fail-fast` / `approval.fail-fast`）。
> 2. 根目录优先取宿主的 `dshHomePath('logs', 包名)`（`ctx.get('dshHomePath')`），拿不到才退回 `$DSH_HOME`，再退回 `~/.dsh`。
> 3. `dispose()` 必须**同步**把剩余批次写完：异步 flush 在进程/测试结束时经常来不及，会丢掉最后一批（真机 bug：dispose 后文件为空）。
> 4. 单元测试必须隔离 `DSH_HOME`（`tests/setup.mjs` 由 `--import` 加载，**无条件**覆盖为临时目录）——这台机器的 `DSH_HOME` 是全局设的，"
>    仅在未设置时才改"根本不生效，曾把 11.9 KB 日志写进用户真实 home。


### 1.1 API（逐字）

```ts
type LogLevel = 'info' | 'warn' | 'error'          // 刻意没有 'debug'

interface EventLogger {
  logEvent(level: LogLevel, event: string, detail: string): void
  exportLogs(header: Record<string, string>, snapshot?: string[], priorSessions?: string[]): string
  readPersistentLog(maxLines?: number): string[]
  flush(): Promise<void>
  dispose(): void
}

function createEventLogger(pluginName: string): EventLogger
function sanitize(text: string): string
```

**工厂而非单例**（每插件独立实例：独立缓冲、独立 `~/.dsh/logs/<pluginName>/`）。

### 1.2 常量（全部保留原名与原值）

| 常量 | 值 | 作用 |
|---|---|---|
| `MAX_ENTRIES` | `200` | 内存环形缓冲条数 |
| `DETAIL_MAX` | `600` | `detail` 截断长度 |
| `PERSISTENT_MAX_BYTES` | `256 * 1024` | 单周文件上限，超了 trim 掉前半 |
| `KEEP_WEEKS` | `4` | 周轮转保留周数 |
| `FLUSH_INTERVAL_MS` | `5_000` | 定时 flush 间隔（`unref`） |
| `FLUSH_THRESHOLD` | `50` | 待写行数阈值，达到即立即 flush |

### 1.3 数据结构与状态机

```ts
interface LogEntry { at: string; level: LogLevel; event: string; detail: string }  // 内部
```

写路径（全程同步、无 await）：

```
logEvent(level, event, detail)
  → sanitize(detail).slice(0, 600)
  → entries.push；>200 则 splice 最旧
  → 若 persistenceEnabled：
       refreshWeek()                     // 周 key 变了才 mkdir + stat + 清理
       pendingLines.push(JSON.stringify({ at, level, event, detail }))
       pendingLines.length >= 50 && void flushPending()
```

读路径：`readPersistentLog(maxLines = 80)` 用 `readFileSync` 读本周文件，**并把尚未 flush 的 `pendingLines` 追加在尾部** —— 逻辑日志"同步可见"，调用方无需先 `await flush()`。

flush 四守卫（缺一不可）：`!persistenceEnabled` / `flushing` / `pendingLines` 空 / `currentFile === ''`。取批次用 `splice(0)`；`appendFile` 是**唯一异步写盘**；失败则把批次 `unshift` 回队首并**熔断**。

状态机：`enabled --(mkdir/stat/append 抛错)--> disabled`（单向，永不自动恢复）。

### 1.4 三层容量控制（协同，缺一不可）

| 维度 | 机制 | 缺了会怎样 |
|---|---|---|
| 横向（文件数） | 周轮转 + 保留 4 周 | 文件无限增长 |
| 纵向（单文件） | 256 KiB 上限 + trim 保留后半 | 一周几十 MB，trim 每 5 s 重写大文件 |
| 内存 | 200 条环形 + `detail` 600 字 | 内存无界；巨型 `detail` 挤掉窗口 |

**周 key 用周一**（`(getDay() + 6) % 7` 回拨）：同一周内文件名不变，避免"上周三的日志在哪个文件"。

### 1.5 `sanitize` 11 条规则（串行叠加，顺序即优先级）

| # | 规则 | 输出 |
|---|---|---|
| 1 | 家目录 | → `~` |
| 2 | 控制字符 `[\u0000-\u001f\u007f]` | 删除（防日志注入/拆行） |
| 3 | `sk-[A-Za-z0-9_-]{8,}` | `sk-***` |
| 4 | `gh[pousr]_[A-Za-z0-9]{16,}` | `gh*_***` |
| 5 | `npm_[A-Za-z0-9]{16,}` | `npm_***` |
| 6 | `bearer\s+\S+`（忽略大小写） | `Bearer ***` |
| 7 | `cookie` / `set-cookie` + 分隔符 + 余下 | `$1$2***` |
| 8 | JWT 三段 base64url（`eyJ…`） | `jwt.***` |
| 9 | 大陆手机号 `1[3-9]\d{9}`（前后非数字） | `1**********` |
| 10 | 18 位身份证 `\d{17}[\dXx]`（前后非数字） | `******************` |
| 11 | `authorization` / `token` / `apikey` / `api-key` / `password` / `mtoken` / `x-auth-token` + 分隔符 + 非空白 | `$1$2***` |

取舍：**串行而非首命中返回**，宁可过度脱敏。三个调用点：`logEvent` 的 detail、`exportLogs` 的 header、`exportLogs` 的事件行。

### 1.6 `exportLogs` 文本结构（消费方直接展示，不能改）

```
# <pluginName> log export
<header k>: <v>                      (逐条 sanitize)
timestamps: UTC — this machine is UTC+08:00 (Asia/Shanghai), so add 8h for local time
## profile state
…
## previous sessions (persisted log)
…
## events this session
<at> [<level>] <event>: <detail>
```

空缓冲输出 `(none — the buffer starts empty on every start)`。时区说明用 `Intl.DateTimeFormat`，**包 `try/catch`**（精简 ICU 环境会抛）。

### 1.7 失败模式（照抄 0.1.6 表）

| 场景 | 表现 | 处理 | 残余风险 |
|---|---|---|---|
| 目录不可写 | 只留内存 | `refreshWeek` catch → `disabled` | 无提示（靠调用方第一次 `readPersistentLog()` 发现为空） |
| `appendFile` 失败 | 批次回放 + 熔断 | `pendingLines.unshift(...batch)` | 熔断后进程退出即丢 |
| 进程崩溃 | 最多丢 5 s / 50 条 | 无 | 关键事件应 `await logger.flush()` |
| 单周超 256 KiB | trim 保留后半 | async `readFile + writeFile` | trim 期间事件在内存，不丢 |
| 同 `pluginName` 多实例 | 写同一文件 | 各自独立 pending / 定时器 | 字节计数独立 → trim 误判 |
| `dispose()` 与在飞 flush 交错 | 最后一批留 pending | `dispose` 先 `void flushPending()` 再关 | 随进程退出丢失（接受，`dispose` 是同步签名） |
| 日志含换行 | 是否拆多行 NDJSON | `sanitize` 删 `\u0000-\u001f` | 已处理（JSON 后仍单行） |

### 1.8 0.2 适配

- **无变更**。`ctx.logger` 在 0.2 仍是 cordis 根 context 自有属性（不是 service），所以 `event-log` 与 `ctx.logger` **并存不替代**的定位不变。
- 新增要求：`createEventLogger` 的 pluginName 要能被消费方覆盖（0.1.6 里 `questions` 用 `'dsh-magica'`，`ephemeral` 用 `'magica:sessions/ephemeral'`，两个名字风格不一致 —— 统一为 `<包名>` 或 `<包名>/<子模块>`）。

### 1.9 测试契约（10 条）

1. `sanitize` 11 条规则各一条用例，且**顺序**固定（`sk-` 先于 `token=`）。
2. `logEvent` 超 200 条丢最旧。
3. `detail` 超 600 截断。
4. `pendingLines` 到 50 立即 flush（mock `appendFile`）。
5. 5 s 定时器 `unref`（`timer.hasRef() === false`）。
6. `appendFile` 抛错 → 批次回放 + `persistenceEnabled === false`，且**后续 `logEvent` 不再尝试写盘**。
7. `readPersistentLog` 合并未 flush 的 pending（无需 await）。
8. `exportLogs` 段落标题逐字 + 空缓冲占位串。
9. 周 key 跨周计算（周一 00:00 边界）。
10. `dispose()` 幂等 + 之后 `logEvent` 仍可用（只写内存）。

---

## 2. `crypto`（0.1.6 的 `field-crypto`）—— 单字段加解密

### 2.1 API（逐字）

```ts
interface FieldCryptoOptions {
  masterKeyPath?: string   // 默认 ~/.dsh/storages/codeagent/master.key
  storageDir?: string      // 默认 dirname(masterKeyPath)
  strictEncrypt?: boolean  // 默认 false；spellbook 自用路径传 true
}

interface FieldCryptoHandle {
  encryptField(plain: string): string
  decryptField(ciphertext: string): string
  readMasterKey(): Buffer
}

function createFieldCrypto(options?: FieldCryptoOptions): Promise<FieldCryptoHandle>
```

⚠️ `createFieldCrypto` 是**异步**的（首次可能要建 key），`createProxyFetch` 是**同步**的 —— 两个工厂同步性相反，写错不报错，只是拿到 `Promise` 当句柄用。

### 2.2 两条路径

| 平台 | 机制 | 密钥位置 | 密文形态 |
|---|---|---|---|
| Windows 且 `@primno/dpapi` 可用 | `protectData(..., 'CurrentUser')` | Windows 凭据库（**不落盘**） | base64 |
| Windows 无 dpapi / Linux / macOS | AES-256-GCM | `masterKeyPath` 里 32 字节随机（`0600`） | `ivHex:tagHex:cipherHex` |

`@primno/dpapi` 两级加载：`createRequire(import.meta.url)` → 失败回退 `$DSH_HOME/profiles/web/node_modules/@primno/dpapi/package.json` 作锚点。**用 `createRequire` 而非静态 import**：避免 TS2307，也避免把它打进产物；两级都失败返回 `null`，降级 AES。

### 2.3 密钥纪律（两条硬规则）

| 编号 | 规则 | 理由 |
|---|---|---|
| FC-1 | **解密绝不创建 key**：`tryReadMasterKey()` 只读、≥32 字节截前 32 并缓存、读不到返回 `null` | 解密路径若顺手建 key，会把"旧 key 丢失"伪装成"解不开"，且往磁盘写垃圾 |
| FC-2 | **创建 key 用排他 flag**：`writeFileSync(path, key, { mode: 0o600, flag: 'wx' })`，`EEXIST` 时**重读赢家 key** 并用它加密 | 并发首建：A/B 同读 `null` → A 成功 → B 必须用 A 的 key，否则下次启动只认 A、B 写的数据永久解不开 |

### 2.4 加解密行为（逐字语义）

`encryptField`：
- 空串原样返回（**不做 `''` → 密文**，否则"未配置"与"配置了空值"不可区分）。
- DPAPI 失败**降级 AES，绝不回退明文**。
- AES 抛错时：`strictEncrypt ? throw : return plain`（历史契约，见 §2.6）。

`decryptField`（**永不抛错、永不解假数据**）：
- 空串原样返回；
- DPAPI 成功即返回，抛错继续试 AES；
- AES：无 key → 返回原密文；分段数 ≠ 3 → 返回原密文；GCM 认证失败 → 返回原密文。
- **调用方判据**：`decryptField(c) === c` 即"没解开"。

### 2.5 安全边界

- 算法：`aes-256-gcm`，12 字节随机 IV，GCM tag 保完整性。
- **已知限制**：未使用 AAD → 密文不绑字段名，字段间可互换（攻击者能把 `password` 的密文搬到 `token` 上）。spellbook 的定位是"配置文件里的敏感字段别明文"，不是抗主动攻击；若将来要抗，加 AAD（字段名 + 用途）并保留无 AAD 重试路径。
- IV 随机无计数器：碰撞概率可忽略但非零。
- 密钥文件权限**只在创建时设**，已存在不修正（用户改了权限我们不动）。

### 2.6 必须保留的两处历史契约

| 契约 | 默认值 | 谁依赖 |
|---|---|---|
| `strictEncrypt: false` | 加密失败返回明文（不抛） | 已有消费者（codeagent / webide 的凭据字段）；改默认值是**破坏性变更**，要发版本公告 |
| 解密不抛、解不开返回原密文 | — | 所有调用方都靠 `=== ciphertext` 判断 |

**spellbook 自己的调用点必须显式传 `strictEncrypt: true`**（我们不允许静默存明文）。

### 2.7 0.2 适配

- **无变更**（不碰 dsh 包）。
- 但要注意：`$DSH_HOME/profiles/web/node_modules` 的目录布局是 0.2 的部署约定（`packages/boot/app-boot/src/profile.ts`），`loadDpapi` 的第二级锚点依赖它，实现时要复核该路径在 0.2 仍成立（⚠️ 待核）。

### 2.8 测试契约（8 条）

1. AES 往返；2. `''`→`''`；3. 解不开返回原密文（无 key / 段数不符 / 篡改 tag）；4. 并发首建 key 只产生一份且双方都能解；5. `0600` 权限；6. `strictEncrypt` 两态行为；7. DPAPI 不可用降级 AES；8. `readMasterKey()` 被调用时才创建（不在构造期）。

---

## 3. `router`（0.1.6 的 `http-route`）—— 进站 HTTP 路由助手

### 3.1 为什么要它

`webServer.register({ kind, path, handler })` 只给裸 `(req, res)`（✅ 0.2 未变，`packages/host/webserver/src/index.ts`）。每个插件都会重复抄同一套：方法判定、同源围栏、content-type、体积上限、JSON 解析、错误信封、`headersSent` 守卫。0.1.6 有三个插件各抄了一份，`http-route` 把它们收成两层 API。

### 3.2 API 全表（19 个导出 = 10 函数 + 8 类型 + 1 class）

**响应层**

```ts
function sendResponse(res: ServerResponse, status: number, body: string | Buffer, headers?: Record<string, string>): void
function sendJson(res: ServerResponse, status: number, payload: unknown): void
function sendText(res: ServerResponse, status: number, text: string, contentType?: string): void
function sendMethodNotAllowed(res: ServerResponse, allow: string): void
```

- `sendResponse` 是**唯一**写响应处：`if (res.headersSent) return` → `writeHead` → `end`。
- `sendJson`：`JSON.stringify` + `cache-control: no-store` + `content-type: application/json; charset=utf-8`。
- `sendText`：原样 + `no-store` + 可覆盖 content-type。
- `sendMethodNotAllowed`：`405` + `allow: <methods>`。

**请求层**

```ts
function sameOrigin(request: IncomingMessage): boolean
function readJsonBody(request: IncomingMessage, maxBytes?: number): Promise<unknown>   // 默认 8192
function queryOf(request: IncomingMessage, key: string): string | null
```

- `sameOrigin`：`origin` 或 `host` 缺失 → `false`；`new URL(origin).host === host`；解析失败（含 `Origin: null`）→ `false`。**比 `.host`（含端口）**，同主机不同端口算跨站。
- `readJsonBody`：`for await` 流式累加、**每块**检查累计大小、超限 `throw new Error('request body too large')`；`Buffer` 回退 `Buffer.from`。
- `queryOf`：手写解析（不用 `new URL`，避免非法 URL 抛错或编造假基址）；解码失败**跳过该 pair 继续**；`?flag` 返回空串。

**单条包装器**

```ts
interface JsonRouteContext { request: IncomingMessage; query(key: string): string | null }
type JsonRouteResult = unknown | { status: number; body?: unknown }
interface JsonRouteOptions { method: string; maxBytes?: number; handler(body, ctx): Promise<JsonRouteResult> | JsonRouteResult }
function jsonRoute(options: JsonRouteOptions): (req, res) => Promise<void>
```

四段：方法不等 → 405；`!sameOrigin` → 403 `{ error:'forbidden', message:'same-origin request required' }`；读体失败（非 GET/HEAD）→ 400；handler 抛错 → 500。`needsBody = method !== 'GET' && method !== 'HEAD'`。
**陷阱**：返回 `{ status, body }` 的识别是 `typeof result.status === 'number'` —— 响应体里**不要**有名为 `status` 的数字字段。

**表驱动路由器**

```ts
type JsonRouterMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS'
type JsonRouterTrust = 'strict' | 'browser'
class HttpRouteError extends Error { constructor(readonly status: number, readonly code: string, message: string) }
function isTrustedInbound(request: IncomingMessage, trust?: JsonRouterTrust): boolean   // 默认 'strict'

interface JsonRouterContext {
  readonly request: IncomingMessage
  readonly response: ServerResponse
  readonly params: Readonly<Record<string, string>>
  query(key: string): string | null
  readonly body: Readonly<Record<string, unknown>>
}
interface JsonRouterRoute { readonly method: JsonRouterMethod; readonly path: string; handler(ctx: JsonRouterContext): Promise<void> | void }
interface JsonRouterOptions {
  readonly prefix: string
  readonly routes: readonly JsonRouterRoute[]
  readonly trust?: JsonRouterTrust          // 默认 'strict'
  readonly maxBytes?: number                // 默认 8192
  readonly requireJsonContentType?: boolean // 默认 true
  readonly allow?: string
  onError?(response: ServerResponse, error: unknown): void
  onNotFound?(response: ServerResponse): void
}
function createJsonRouter(options: JsonRouterOptions): (req, res) => Promise<void>
```

### 3.3 闸门顺序（不可调整，这是本模块的核心价值）

```
1. 方法门       请求方法不在表里 → 405 + Allow（表级，对任何路径）      → 不泄漏路径是否存在
2. 信任围栏     isTrustedInbound(request, trust) → 403 forbidden        → 未命中的 POST 一样过闸
3. 读体闸门     content-type → 声明长度 → 解析（415 / 413 / 400）        → 攻击者不透传大 body
4. 匹配         方法 + 路径段 → 未命中 onNotFound（默认 404 空体）
5. 业务         handler 自己写响应（可长期持有 response）
6. 兜底         handler 抛错 → onError（信封由我们自己保证）
```

**为什么不能换序**：先匹配再判方法 → 404/405 泄漏路径存在性；先读体再判信任 → 攻击者无需同源即可让服务端读 8 KB；先匹配再读体 → 未命中 POST 跳过 content-type 检查，产生绕过。

`isTrustedInbound` 三档语义：

| `sec-fetch-site` | `origin` | `strict` | `browser` |
|---|---|---|---|
| `cross-site`（大小写不敏感） | 任意 | 拒 | 拒 |
| 缺 | 缺 | 拒 | **放行**（curl / 脚本 / 测试） |
| 缺 | 有且同 host | 放行 | 放行 |
| 缺 | 有但异 host | 拒 | 拒 |

**`browser` 档的论证**：只有浏览器会被第三方页面骗去发请求，而浏览器的 POST 一定带 `Origin`；不带 `Origin` 的只可能是本机脚本，而脚本本来就能直接读磁盘上的配置。**代价**：`browser` 档没有 Host 头围栏（DNS-rebinding 防护），那是部署策略，由注册方自己加。

### 3.4 错误码映射与固定文案（逐字）

| 场景 | 状态 | `error` | `message` |
|---|---|---|---|
| 方法不在表里 | 405 | — | （`sendMethodNotAllowed`，带 `allow` 头） |
| 跨站 / 非同源 | 403 | `forbidden` | `cross-origin request rejected` / same-origin 变体 |
| content-type 非 JSON | 415 | `invalid_input` | `content-type must be application/json` |
| 声明长度超限 | 413 | `invalid_input` | （体积消息） |
| 体积超限（chunked） | 400 | `invalid_input` | `body is not valid JSON or too large` |
| 解析结果非对象 | 400 | `invalid_input` | `body is not a JSON object` |
| 未命中 | 404 | — | 默认空体（`onNotFound` 可覆盖） |
| handler 抛错（`HttpRouteError`） | 自带 | 自带 | 自带 |
| handler 抛错（其他） | 500 | `internal` | — |

**为什么 413 要单独判 `content-length`**：`readJsonBody` 也会拒超限，但它抛的是内部措辞的 `Error`；若靠字符串匹配区分，改文案就静默退化成 400。

### 3.5 失败模式

| 场景 | 表现 | 处理 |
|---|---|---|
| handler 已写响应又抛错 | `onError` 再写 | `headersSent` 守卫静默返回（不抛 `ERR_HTTP_HEADERS_SENT`） |
| 客户端断开 | `for await` 抛 | 走 500 / `onError`，进程不崩 |
| 畸形百分号编码 | `queryOf` 跳过、`decodePathSegment` 保留原文 | 静默降级，不抛 |
| 前缀碰撞（`/magicax`） | 不匹配 `/magica` | `segmentsAfterPrefix` 要求 `rest === '' \|\| rest === '/' \|\| startsWith('/')` |
| `request.url` 缺失 | `''` → 404 | `request.url ?? ''` |
| 重复 `(kind, path)` | `webServer.register` **抛错** | 注册前先 `dispose()`；或换 `prefix` |
| `webserver` 的裸 400 兜底 | 逃出 `onError` 的异常 → 裸 400 空体 | 本模块用 `try/catch` 全兜，正常路径不会触发 |

### 3.6 0.2 适配

- **`webServer` 契约未变** ✅：`register` 返回 disposer、重复注册抛错、prefix 语义（`p` 与 `p/...`）、最长前缀优先。
- ⚠️ 核对项：0.2 是否有 `webserver/index-inject` 之类的新事件影响我们的注册方式（当前不用）。
- 新增要求：给 `JsonRouterOptions` 加 `trustedHosts?: string[]`（Host 头围栏），默认空 —— 把"部署策略"的选择权显式化，而不是继续缺失。

### 3.7 测试契约（12 条）

1. 方法门对未声明方法返回 405 + `allow`（顺序去重）。
2. 未命中的 POST 仍过围栏与读体闸（用跨站请求验证 403 先于 404）。
3. `strict` 与 `browser` 两档 ×（cross-site / 无 origin / 同源 / 异源）= 8 组。
4. content-type 非 JSON → 415（`requireJsonContentType: false` 时放行）。
5. `content-length` 超限 → 413；chunked 超限 → 400 合并消息。
6. 非对象 JSON（数组 / 标量 / `null`）→ 400 `body is not a JSON object`。
7. `:name` 段必须非空（`/tasks//move` 不命中）。
8. 前缀碰撞不匹配。
9. `headersSent` 后写响应静默返回。
10. handler 抛 `HttpRouteError` 用自带 status/code；其他 → 500 `internal`。
11. `onNotFound` 覆盖默认 404。
12. `queryOf` 处理 `?flag`、重复键、畸形编码。

---

## 4. `net`（0.1.6 的 `proxy-fetch`）—— 内网出站

### 4.1 为什么不能用 `ctx.web.fetch`

官方 `ctx.web.fetch` 自带 SSRF 防护：本地 provider 只放行**公网单播**地址（`packages/web/web-fetch-http/src/network.ts` 的 `isPublicIpAddress` / `resolvePublicAddresses`）。企业内网自签证书、内网域名、必须走代理的端点**全部连不上**。spellbook 因此自持一套（0.1.6 是 lattice 逼出来的，0.2 的 lattice 仍在用）。

### 4.2 API（逐字）

```ts
interface ProxyFetchInit { method?: string; headers?: Record<string, string>; body?: string | Buffer; signal?: AbortSignal; timeoutMs?: number }
interface ProxyFetchOptions { defaultTimeoutMs?: number /* 30000 */; insecure?: boolean /* 默认 true */ }
interface ProxyFetchHandle {
  fetch(url: string, init?: ProxyFetchInit): Promise<Response>
  configuredProxy(): string | null
  insecureFetch(url: string, init?: ProxyFetchInit): Promise<Response>
  insecureAgent: Agent           // undici
  insecureHttpsAgent: https.Agent // node:https
  dispose(): Promise<void>
}
function createProxyFetch(options?: ProxyFetchOptions): ProxyFetchHandle        // 同步
function createLimitedFetch<T>(fetcher: (url: string, init?: T) => Promise<Response>, concurrency: number): (url: string, init?: T) => Promise<Response>
```

`createLimitedFetch`：`concurrency` 向下取整、**下限 1**；`active` 计数 + 队列；`release()` 在 `finally`（出错也放槽）。

### 4.3 惰性 `undici` 的三重理由（缺一个就挂）

| 层 | 手段 | 解决的问题 |
|---|---|---|
| 安装 | `undici` 放 `dependencies` | "本包装上了" |
| 解耦 | 独立子路径 `./proxy-fetch`，主入口**不**转出 | "只用其他模块的人不必装" |
| 求值 | `createRequire(...)` 在**函数内**同步 `require` | "import 主包不触发 undici 解析" |

第三层是必须的：即使改动态 `import()`，主入口的 `export *` 仍会在求值期链到它 → 没装 `undici` 就 `ERR_MODULE_NOT_FOUND`。顶层只留 `import type` 与 `typeof import('undici')`。

### 4.4 请求路径

```
fetch(url, init)
  → undici() 惰性加载
  → new UndiciAgent({ connect: { rejectUnauthorized } })   一次构建
  → new https.Agent({ rejectUnauthorized })                 一次构建
  → AbortSignal.timeout(init.timeoutMs ?? defaultTimeoutMs)
    与 init.signal 用 AbortSignal.any 合并（不泄漏监听器）
  → proxyFromEnv() 每次重读
  → 无代理：dispatcher = insecureAgent
    有代理：proxyAgent ??= new EnvHttpProxyAgent(...)      懒建复用
```

### 4.5 代理感知

`pick()`：空/纯空白 → `null`；无 scheme 补 `http://`。
`proxyFromEnv()` 优先级：`https` 用 `https_proxy ?? HTTPS_PROXY ?? npm_config_https_proxy`；`http` 用 `http_proxy ?? HTTP_PROXY ?? npm_config_proxy`。四点：小写优先、`https` 无自身代理时**回退 http 代理**、空值视为未设、`npm_config_*` 是额外来源。

⚠️ 已知：代理 env 在首次 `proxyAgent ??=` 后**变更不生效**（`??=` 缓存）；`NO_PROXY` 的精细匹配依赖 `EnvHttpProxyAgent` 自身实现。

### 4.6 TLS 与超时

- `rejectUnauthorized = !(insecure ?? true)`。
- **`insecureAgent`（undici）与 `insecureHttpsAgent`（node:https）不可互换**：undici Agent 不能用于 `https.request`。
- 替代全局 `NODE_TLS_REJECT_UNAUTHORIZED` —— AGENTS 二.3 允许企业内网场景用环境变量，但**限定作用域的 Agent 是更好的做法**，本设计采用后者。
- `insecureFetch` **不加默认超时**（既有契约，流式长响应会被总超时掐断）；调用方自备 `signal` / `timeoutMs`。

### 4.7 失败模式

| 场景 | 表现 |
|---|---|
| 未装 undici | import 主包不报错；首次 `createProxyFetch()` 才抛（运行期而非安装期） |
| 代理 env 非法 | `pick` 只补 scheme，`EnvHttpProxyAgent` 构造抛 → 调用方 try/catch |
| 代理中途变更 | 不生效（`??=`） |
| `dispose()` 后继续 fetch | `disposed` 只挡重复 `dispose`，不挡 fetch（**已知**） |
| 并发无上限 | 提供 `createLimitedFetch` 但不强制；libuv 只有 4 槽，建议 2~4 |

`dispose()`：已置位 → 返回；`try { await insecureAgent.close(); await proxyAgent.close() } catch {}`；`try { insecureHttpsAgent.destroy() } catch {}`；**永不 reject**（`close` 而非 `destroy` 以等在飞请求）。

### 4.8 0.2 适配

- **无 API 变更**。
- ⚠️ 核对：0.2 的 `ctx.web.fetch` 是否已支持自定义 dispatcher / 内网白名单。若已支持，应把 `proxy-fetch` 降级为"仅企业自签场景"的备用路径（当前按未支持设计）。

### 4.9 测试契约（8 条）

1. 主入口 import 不触发 undici 解析（`require('undici')` 计数为 0）。
2. `undici` 缺失时 `createProxyFetch` 才抛。
3. 代理优先级 6 组（大小写 × http/https × npm_config）。
4. `rejectUnauthorized` 由 `insecure` 反向控制。
5. `AbortSignal.any` 合并后两者任一 abort 都生效。
6. `createLimitedFetch` 并发上限 + 出错也放槽。
7. `dispose()` 幂等、不 reject。
8. `insecureFetch` 无默认超时。

---

## 5. `pricing.ts` —— token 货币定价

### 5.1 为什么官方没有

`ctx.tokenMeter` 只做**启发式 token 数估算**（README 明确"非 billing record"）；`ctx.llm.imageRequestPricing` 只覆盖图片视觉 token。**货币级 ¥/token 定价表官方无** → spellbook 提供。

### 5.2 API（逐字）

```ts
interface PriceEntry { family: string; model: string; cacheHit: number; cacheMiss: number; output: number }
type PriceTable = PriceEntry[]

function loadPriceTable(filePath?: string): PriceTable
function priceForModel(routeModel: string | undefined, table: PriceTable): PriceEntry | undefined
function stepBill(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number } | undefined,
                  routeModel: string | undefined, table: PriceTable): number
function stepOutputBill(usage: { outputTokens: number } | undefined,
                        routeModel: string | undefined, table: PriceTable): number
```

单位：元 / 百万 token。`stepBill = (input × cacheMiss + cacheRead × cacheHit + output × output) / 1e6`。

### 5.3 三层匹配

| 层 | 条件 | 取值 | 例 |
|---|---|---|---|
| 1 model | 路由模型名（normalize 后）**包含**表中某 `model`，最长匹配优先 | 该条 | `GLM-5.2-Auto(BaiLian)` → `glm5.2` → GLM-5.2 |
| 2 family | model 未命中，路由名含某 `family` | 该家族第一条 | `GLM-5.9-Foo` → `glm` → GLM 第一条 |
| 3 兜底 | 都没命中 | deepseek flash 第一条 | `SomeUnknownModel` → deepseek-v4-flash |

`normalize = 全小写 + 去掉 '-'`（`GLM-5.2-Auto` → `glm5.2auto`）。

### 5.4 运行时安全

- 默认表**闭包缓存**（首次 `readFileSync` 后复用）；传 `filePath` 则每次读（调用方低频覆盖）。
- 全 `try/catch`，失败返空表（账单为 0，不抛）。
- 0.2 适配：**无**。⚠️ 但表格数据会随模型更新过期 → 本设计增加 `PRICE_TABLE_VERSION` 常量并在 `exportLogs` 快照里带上，便于定位"账单为 0 是因为表里没这个模型"。

---

## 6. 本模块对 0.2 的安全复检清单（实现前跑一遍）

| # | 项 | 判据 |
|---|---|---|
| 1 | 热路径同步 I/O | `grep -n "Sync(" src/{event-log,field-crypto,http-route,proxy-fetch,pricing}.ts` 逐个确认是冷路径或原子写 |
| 2 | 未捕获异常 | 每个 `async` 函数要么无 throw 路径，要么调用方 `catch`；`void x()` 的目标函数内部必须有 `try/catch` |
| 3 | 定时器 | 全部 `unref()` 且在 `dispose()` 清掉 |
| 4 | 并发 | 出站 fetch 必带超时；批量操作走 `createLimitedFetch` |
| 5 | 全局副作用 | 无 `process.env.*=*` 赋值；TLS 只经 Agent |
| 6 | 敏感数据 | 任何写盘/写日志的字符串先过 `sanitize`；密文字段不落明文 |

---

## 7. 与 0.1.6 的差异汇总（除 §2.6 保留项外）

| # | 项 | 0.1.6 | 0.2 设计 |
|---|---|---|---|
| 1 | `http-route` 的 Host 头围栏 | 缺失（把责任推给注册方） | 新增 `trustedHosts?: string[]`（默认空 = 保持旧行为，但可显式开启） |
| 2 | `pricing` 表版本 | 无 | 加 `PRICE_TABLE_VERSION`，写进诊断快照 |
| 3 | `field-crypto` 的 AAD | 未使用 | 保持未使用（兼容优先），但在文档里标为"已知限制" |
| 4 | `proxy-fetch` 的 `dispose` 后 fetch | 未挡 | 加 `disposed` 守卫直接 reject（**行为变更**，需版本公告） |
| 5 | `createEventLogger` 的命名 | 两种风格混用 | 统一 `<包名>` / `<包名>/<子模块>` |
| 6 | `http-route` 的 `jsonRoute` 返回识别 | `typeof result.status === 'number'` | 保持（文档标注陷阱），不改 |
