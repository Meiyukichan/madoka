# dsh-teamwork · 数据库表设计

> **本文是新库唯一的 DDL 基线。** 表、列、索引、约束、预置数据全部以本文（§4）为准。
> **本文是唯一的 DDL 基线。** 表、列、索引、约束、预置数据全部以本文（§4）为准。
> 命名与语义的上层约定见 [`server-design.zh.md`](./server-design.zh.md)。
> 目标库：**SQLite（`node:sqlite` / `DatabaseSync`），版本 3.53.3**。共 **9 张表 / 30 个索引 / 19 个 CHECK / 1 个外键**。

---

## 0. 验证记录（本文 DDL 已实跑，不是纸面设计）

在 `node v24.19.0` + SQLite `3.53.3`、临时文件库上完整执行 §4 的 DDL 后实测：

| 检查项 | 结果 |
|---|---|
| 建表数 | `9`（`dsh_teamwork_*` 全部就位） |
| 索引数 | `30`（不含 `sqlite_autoindex_*`） |
| CHECK 约束数 | `19` |
| 外键数 | `1`（仅 `project_member→project`；会话表已删） |
| `PRAGMA user_version` | `1` |
| `PRAGMA integrity_check` | `ok`（建库后与压测后各一次） |
| 预置 `issue_source` | `3` 行，重复执行不新增（`ON CONFLICT DO NOTHING`） |

已被实测**证明可用**的行为（写代码时别再怀疑或绕开）：

| 行为 | 实测结果 |
|---|---|
| 部分唯一索引 + `ON CONFLICT (a,b) WHERE ... DO UPDATE` | 工作区 `index`/`portal` 各上报 2 次，行数恒为 1 |
| `member` / `device` / `account`（含 `global_role`）upsert | 各 2 次写入 → 1 行 |
| 评论幂等 | 同 `comment_id` 写 2 次 → 1 行 |
| 认领条件更新 | `WHERE status='pending'` 第一次 `changes=1`，第二次 `changes=0` |
| issue upsert 不冲回状态 | 已 `accepted` 的记录再提交 `status=pending`，仍是 `accepted`；`urgency` 被更新 |
| `AUTOINCREMENT` 不复用 id | 删掉 `id=2` 再插入 → 新 id 是 `3`（游标安全） |
| 时间戳字典序 = 时间序 | `2026-11-11T11:09:25.726Z` < `.734Z`，`sort()` 结果不变 |
| 表达式索引被查询计划使用 | 复合表达式索引 `SEARCH ... USING INDEX`，`COUNT(*)` 走 `COVERING INDEX`，**无 TEMP B-TREE** |
| `project_id` 复合索引 | `WHERE project_id=? ORDER BY created_at DESC` 走索引，无 TEMP B-TREE |
| CHECK 真的拦得住 | `account_token` 列拒绝明文密码 / 大写 hex / 长度不足（`ck_tw_account_token`）；`type=index` 带 `cwd` → `ck_tw_ws_shape` 拒绝 |
| 外键级联 | 删 `project` → 成员行自动清空（全库唯一外键） |

---

## 1. 通用约定

### 1.1 类型映射（通用 SQL 类型 → SQLite）

| 通用 SQL 类型 | SQLite | 注意 |
|---|---|---|
| `BIGSERIAL PRIMARY KEY` | `INTEGER PRIMARY KEY AUTOINCREMENT` | **必须 `AUTOINCREMENT`**：评论游标靠自增 id，删行后复用 id 会让增量查询漏/重 |
| `VARCHAR(n)` | `TEXT` | SQLite 不执行长度；长度护栏用 `CHECK` 或应用层 |
| `TIMESTAMPTZ DEFAULT now()` | `TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` | UTC、毫秒、字典序 = 时间序 |
| `TEXT`（JSON 字符串） | 同 `TEXT` | 用 `json_extract` 查询 |
| `ILIKE '%x%'` | `LIKE '%x%'` | ASCII 大小写不敏感；中文无影响 |
| 部分唯一索引 + `ON CONFLICT … WHERE` | **语法完全一致** | 已实测 |
| `useGeneratedKeys` | `INSERT … RETURNING id` | SQLite ≥ 3.35 |
| `@AutoPaging` / PageHelper | `COUNT(*)` + `LIMIT ? OFFSET ?` | 两条预编译语句 |
| 外键 `ON DELETE CASCADE` | 同语法 | **每连接必须 `PRAGMA foreign_keys=ON`** |

### 1.2 连接初始化（每个连接开库后立刻执行，不可省）

```sql
PRAGMA journal_mode = WAL;      -- 并发读 + 单写；文件库生效
PRAGMA synchronous  = NORMAL;   -- WAL 下的合理取舍
PRAGMA busy_timeout = 5000;     -- 遇到锁等 5s 而不是立刻 SQLITE_BUSY
PRAGMA foreign_keys = ON;       -- 默认是 OFF！漏了级联就不生效
```

> `PRAGMA foreign_keys` 在事务内设置**无效**，只能在事务外设置。迁移脚本里不要依赖它。

### 1.3 命名

| 对象 | 规则 | 示例 |
|---|---|---|
| 表 | `dsh_teamwork_` + 单数名词 | `dsh_teamwork_issue` |
| 列 | `snake_case` | `assignee_instance`、`created_at` |
| 唯一索引 | `uk_tw_*` | `uk_tw_issue_id` |
| 普通索引 | `idx_tw_*` | `idx_tw_issue_assignee` |
| CHECK / 外键 | `ck_tw_*` / `fk_tw_*` | `ck_tw_ws_shape`、`fk_tw_member_project` |

- **索引名一律显式命名**，不用内联 `UNIQUE` 列约束（那会生成 `sqlite_autoindex_*`，文档和 `sqlite_master` 对不上）
- 主键统一 `id`；业务键另有唯一索引（`issue_id` / `comment_id` / `code` / `account_id` / `name`）

### 1.4 `updated_at` 的责任

**没有触发器**，`updated_at` 由仓库层每条 `UPDATE` 显式写
`strftime('%Y-%m-%dT%H:%M:%fZ','now')`。

- 为什么不用触发器：触发器会隐藏写入点、让 `changes()` 语义变浑，也让「这次更新到底改了什么」不可见
- 为什么必须显式：`ON CONFLICT DO UPDATE` 不会自动改 `updated_at`，漏写就会留下「看起来没变」的陈旧数据
- 强制手段：`tests/db/updated-at.test.ts` 遍历所有 `UPDATE` 语句源码，断言都包含 `updated_at`（静态检查，不靠人记）

### 1.5 外键策略（只有 2 个，故意的）

| 关系 | 有外键？ | 理由 |
|---|---|---|
| `account_token.account_id → account.account_id` | ✅ `CASCADE` | token 属于账号，账号没了 token 必须一起没 |
| `project_member.project_id → project.id` | ✅ `CASCADE` | 项目没了成员行必须一起没（全库唯一外键） |
| `project_member.account_id → account` | ❌ | **允许先加人、后注册**：把还没注册的同事拉进项目是正常需求 |
| ~~`whitelist.account_id → account`~~ | — | **表已合并进 `account`**，不存在这个外键议题（§3.3） |
| `issue.assigner / assignee`、`device.account_id`、`issue_comment.author` 等 | ❌ | 弱引用（刻意保持弱引用）：这些字段可能是插件名、外部系统标识，不一定是本库账号 |
| `issue_attachment.issue_id`、`issue_comment.issue_id` | ❌ | 弱引用：允许「先挂附件/先评论、后提交 issue」（刻意不校验存在性） |

### 1.6 枚举与 CHECK 的分界线（一句话）

**系统维护、永不扩值的枚举 → 加 `CHECK`；业务会扩值的枚举 → 不加 `CHECK`，由应用层枚举校验。**

| 加 CHECK（16 个里的枚举部分） | 不加 CHECK |
|---|---|
| `account.status`、`account.global_role`、`project_member.role`、`project.visibility`、`device.status`、`device_workspace.type`、`issue_attachment.type`、**`issue.urgency`、`issue.permission`** | `issue.status` / `issue.source` / `comment_role` / `comment_author_type` / `project.status` |

理由：加 `CHECK` 意味着每次扩值要写迁移（枚举一旦落进 CHECK，扩值就必须写迁移，容易积压）。

---

## 2. 关系图

```
[dsh_teamwork_account]  ← 模块 A 地基
    account_id (uk)
    account_token      ← SHA256("账号:密码")；**同时是 auth_token 的 HMAC 签名密钥**
    （没有会话表：auth_token 由客户端签名，服务端拿本行 account_token 无状态验签）

（全局角色 = account.global_role，不再单独建表）

[dsh_teamwork_project]          status / visibility / created_by
    id (pk), name (uk)
        │ 1:N  FK CASCADE   ← 全库**唯一**外键
        ▼
[dsh_teamwork_project_member]   role: owner / manager / member（owner 唯一）
    uk(project_id, account_id)

[dsh_teamwork_issue]            ← 22 列（含 `project_id` / `title` / `detail`）
    issue_id (uk)               ← 幂等键 / 事件ID
    assigner, assignee          ← 弱引用账号
    project_id                 ← 归属项目（可空；弱引用 project.id）
        │ 弱引用（无 FK）
        ├──► [dsh_teamwork_issue_attachment]   uk(issue_id, file_id)
        ├──► [dsh_teamwork_issue_comment]      uk(comment_id)，id = 增量游标
        └──► [dsh_teamwork_issue_source]       uk(code)，issue.source 弱引用

[dsh_teamwork_device]           uk(account_id, host, port)
        │ 逻辑关联（纯字符串约定，无 FK）：
        │   device.host + ':' + device.port == device_workspace.instance
        │                                     == issue.assignee_instance
        ▼
[dsh_teamwork_device_workspace]
    uk(account_id, instance, workspace_id) WHERE workspace_id IS NOT NULL  -- portal
    uk(account_id, instance)               WHERE workspace_id IS NULL      -- index
```

---

## 3. 逐表设计

### 3.1 `dsh_teamwork_account`（账号 · 新增）

**9 列** / 1 唯一索引 / 4 CHECK。模块 A 的地基。

| # | 列 | 类型 | 空 | 默认 | 写入方 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | — | 主键；**不对外暴露**，接口一律用 `account_id` |
| 2 | `account_id` | TEXT | 否 | — | 注册 | **登录名**，`^[A-Za-z0-9@_-]{3,64}$`，**BINARY 比较（严格区分大小写）**，注册后不可改；全局唯一 |
| 3 | `display_name` | TEXT | 是 | — | 注册/改资料 | 展示名；空则由客户端回退显示 `accountId` |
| 4 | `account_token` | TEXT | 否 | — | 注册/改密/管理员重置 | **`sha256("account_id:password")` 的小写 hex（64 字符；`password` 为 base64 解码后的明文）**；不可逆；**明文永不落库**；**兼任 `auth_token` 的 HMAC-SHA256 签名密钥**（§3.2） |
| 5 | **`global_role`** | TEXT | 否 | `'user'` | 注册/管理员改 | `administrator` / `leader` / `user`；**全局角色**（原 `whitelist.role` 合并进来的，§3.3） |
| 6 | `status` | TEXT | 否 | `'active'` | 管理 | `active` / `disabled`；`disabled` 时登录 403 且已有 token 全部失效 |
| 7 | `last_login_at` | TEXT | 是 | — | 登录/注册 | 最近一次登录成功时刻；**只用于展示与排查，不参与任何判定** |
| 8 | `created_at` | TEXT | 否 | `now` | — | |
| 9 | `updated_at` | TEXT | 否 | `now` | — | |

```sql
CREATE UNIQUE INDEX uk_tw_account ON dsh_teamwork_account(account_id);
CONSTRAINT ck_tw_account_id_len CHECK (length(account_id) BETWEEN 3 AND 64)
CONSTRAINT ck_tw_account_status CHECK (status IN ('active','disabled'))
CONSTRAINT ck_tw_account_role   CHECK (global_role IN ('administrator','leader','user'))
CONSTRAINT ck_tw_account_token   CHECK (length(account_token) = 64
                                   AND account_token NOT GLOB '*[^0-9a-f]*')
```

> `ck_tw_account_token` 是**格式防呆**：只接受 64 位小写 hex。
> 实测拦住三类最容易犯的错——明文密码（`correct horse battery`）、大写 hex、长度不足（`abc123`）。

#### 3.1.0 `account_token` 的公式（需求方指定，实现必须与之一致）

```
account_token = SHA256( utf8( account_id + ":" + password ) )   → 小写 hex，64 字符
                        ↑ password 指【base64 解码后的明文】，编码只影响传输（api-design §0.3）
```

实测样例：`SHA256("alice:correct horse") = 6cc899893df1f9b606795947e338148459daee74b0771dce92138caa08f00c36`

**三条实现铁律**（违反任意一条都会把"弱"变成"灾难"）：

1. **登录校验必须先取密码原文再比对** —— `account_token` 是**验证器**：按 `account_id` 取行 → 算 `SHA256(account_id:password)` → `timingSafeEqual`。
   **禁止**写成「把 `account_token` 直接当登录凭据」（`POST /auth/login` 只接受账号+密码，不接受 `account_token`）。
2. **`account_token` 只作 HMAC 密钥，绝不进 JWT payload** —— payload 是 base64 明文可读；把密钥写进 payload 等于公开发布。
   （§3.2 护栏 1）
3. **分隔符 `:` 与 `account_id` 字符集互斥** —— `account_id` 的正则 `^[A-Za-z0-9@_-]{3,64}$` **不含冒号**，
   所以 `"账号:密码"` 的切分是唯一的。实测反例：`"a:b"+"c"` 与 `"a"+"b:c"` 哈希相同——
   一旦有人放宽字符集允许 `:`，立刻会出现两个不同账号撞到同一个 `account_token`。**改字符集前必须先换分隔符。**

> ⚠️ 需要澄清一处矛盾（**需求方知情选择**）：`account_token` 既是密码验证器、又是 token 签名密钥，
> 因此「拿到它」= 「能签出该账号的 `auth_token`」。所以它在权限上**等价于密码**：
> 不能建索引、不能出现在日志、不能回显在除登录/注册响应以外的任何接口里。
> 登录响应里回传它是**需求方明确要求**（为了让客户端能自己签名），这条风险的完整清单见 §3.2.2。

**已知性质（写在这里，避免以后误判）**：

| 性质 | 说明 |
|---|---|
| 不可逆 | SHA-256 单向，无法从 `account_token` 还原密码 |
| **离线爆破成本低** | 无盐、无 KDF：实测 `SHA-256` 约 **0.71 µs**/次（scrypt 是 **51 ms**，差约 **7 万倍**）。DB 泄露后弱口令可被 GPU 秒级枚举 |
| 无随机盐 | 盐退化为公开的 `account_id`；相同密码在不同账号下结果不同（不撞库），但逐账号爆破仍廉价 |
| 不是加密 | 没有密钥、不可解密；"加密"只是口语说法 |
| 长度扩展攻击不适用 | 该攻击针对 `H(secret‖data)` 当 MAC 的场景；这里只用于等值比对，不产生 MAC |

**因此新增的补偿措施（因为放弃 KDF，这些不再是可选）**：

| 措施 | 原因 |
|---|---|
| 登录限流：每 IP 10 次/分、每账号 5 次/分 + 30 次/时 | 线上爆破是唯一还受控的入口 |
| 密码错误统一延迟 **300 ms** | 把线上尝试压到 ~3 次/秒 |
| 密码最小长度提高到 **12**（原 8）+ 内置弱口令表 | 离线成本已低，**熵是唯一的防线** |
| 运维要求：DB 文件权限、禁止导出明文行、备份加密 | 这一层的安全边界被显著前移了 |

#### 3.1.1 这张表的决策记录（已与需求方逐条确认）

| # | 议题 | 结论 | 影响 / 补偿 |
|---|---|---|---|
| A-1 | 大小写 | **严格区分**：`Alice` 与 `alice` 是两个不同账号（列不声明 `COLLATE NOCASE`） | 唯一索引是 BINARY；登录查询必须精确匹配。**已知风险**：近重名可能被用于冒充（`Alice` / `alice`）。UI 与文档必须提示「账号区分大小写」；若要反悔，改成 `COLLATE NOCASE` 只是一句 DDL + 一次索引重建 |
| A-2 | 登录失败锁定 | **不做**：不加 `failed_login_count` / `locked_until` | 防线全在内存限流，见下方补偿措施；`disabled` 只用于管理员封号 |
| A-3 | 忘记密码 | **仅管理员重置**：`POST /admin/accounts/{accountId}/password`（administrator），成功后**吊销该账号全部 token** | 不引入邮件/SMTP 依赖；找回靠人找管理员 |
| A-4 | 审计 | **只加 `last_login_at`**，不建 `audit_log` 表 | 登录成功（含注册，注册即登录）时更新；不记录失败尝试 |
| A-5 | `email` | **不加** | 没有发信能力；需要通知时走项目成员信息 |
| A-6 | 软删除 | **不加** | `status='disabled'` 已足够；账号行保留便于 token 审计追溯 |
| A-7 | 全局角色 | **就是本表的 `global_role` 列**（原 `whitelist` 表已合并进来，见 §3.3） | 单一真相：原来两表时要靠 COALESCE 兜默认值，还多一次 JOIN |
| **A-8** | **密码存储** | **`account_token = SHA256("account_id:password")`（小写 hex）**，取代原 `password_hash`（scrypt） | **需求方明确要求**。已知降级：抗离线爆破从 51 ms/次 降到 0.71 µs/次；补偿措施见 §3.1.0（限流、300ms 延迟、密码 ≥12 位、禁当凭据、不建索引） |

**A-2 的补偿措施（因为放弃了 DB 层锁定，必需）**：

| 措施 | 参数 |
|---|---|
| 每 IP 登录限流 | 10 次 / 分钟 |
| 每账号登录限流 | 5 次 / 分钟、30 次 / 小时（内存滑动窗口） |
| 失败延迟 | 密码错误统一**人为延迟 300ms** 再响应（抑制爆破吞吐，不影响正常用户感知） |
| 统一错误 | 账号不存在与密码错误返回**同一** `code`/`message`/延迟，不泄露账号是否存在 |
| 重启即清零 | **明确接受**：这是进程内限流，重启后计数归零；若日后需要抗重启爆破，再回来加 A-2 的两列 |

> A-1 不选 `COLLATE NOCASE` 的实测依据（当时评估过）：NOCASE 列可以让 `Alice`/`ALICE` 视为同一账号、
> 保留原值、且 `ON CONFLICT(account_id)` 仍能命中；本次按需求方选择保留严格区分，**该结论记录在此，便于日后反悔时直接用**。

**「首个注册用户 = administrator」的并发要点**（写代码时的硬要求）：

```sql
BEGIN IMMEDIATE;
  -- 单语句：把「数一下」放进 CASE 的子查询里，避免跨语句引用别名
  INSERT INTO dsh_teamwork_account(account_id, display_name, account_token, global_role)
  SELECT ?, ?, ?,
         CASE WHEN (SELECT COUNT(*) FROM dsh_teamwork_account) = 0
              THEN 'administrator' ELSE 'user' END
  RETURNING id, global_role;
COMMIT;
```

实测：第 1 个账号得到 `administrator`，第 2、3 个得到 `user`。

> **一次 INSERT 就够**（`global_role` 是列默认值），不再需要第二条写白名单的语句 —— 这是合并 `whitelist` 后最直接的收益。
> `BEGIN IMMEDIATE` 仍是必需的：`COUNT(*)` 与 `INSERT` 之间必须没有别的写者插进来，否则并发注册会出**两个 administrator**。
> （早前的写法是「先 `SELECT COUNT(*) AS n` 再 `INSERT … VALUES(…, CASE WHEN n = 0 …)`」—— **那是错的**，
> 两个独立语句之间不能引用上一条的别名 `n`。已改成上面的单语句形式。）

**`last_login_at` 的写入点**：注册成功后（注册即登录）+ 每次登录成功。**写失败不影响登录成功**
（这是一条审计字段，不能因为它让用户登不上；`try/catch` + 日志）。

### 3.2 没有会话表（原 `dsh_teamwork_account_token` 已删除）

**需求方决定：不要会话表。** token 由客户端用「账号的 `account_token` 作 HMAC 密钥」自己签出来，服务端只做**无状态校验**：
拿 header 里的 `account_id` 查一行账号 → 用该行 `account_token` 验签 → 校验 `exp`。**没有**签发记录、**没有**清理任务、**没有**心跳写盘。

```
header: dsh-teamwork-token:   <auth_token>      ← HS256 JWT
        dsh-teamwork-account: <account_id>

auth_token = JWT(payload={ a: account_id, ip, iat, exp }, key = account.account_token, alg = HS256)

服务端校验顺序：
  ① 取 header 的 account_id → SELECT account_token, status FROM account WHERE account_id=?
  ② HMAC-SHA256(account_token, header.payload) 与签名常量时间比对
  ③ payload.a === header.account_id（绑定，防串号）
  ④ payload.exp > now 且 payload.exp <= now + TTL(3 天) + 60s   ← 见下方「护栏 2」
  ⑤ account.status = 'active'
  ⑥ （可选，默认关）payload.ip === 本次请求 IP
```

实测（本机）：全流程 **10.38 µs/次**（含查库 + HMAC + JSON 解析）。

#### 3.2.1 三条护栏（不加就是洞，实现时必须写进去）

| # | 护栏 | 不加的后果 |
|---|---|---|
| **1** | `account_token` **绝不进 JWT payload**，只作 HMAC **密钥** | payload 是 base64 **明文可读**；把密钥写进 payload = 每个看到 token 的人都能伪造 |
| **2** | 服务端强制 `exp <= now + TTL + 60s`，超出返回 `exp_too_long` | `exp` 是**客户端填的**，不封顶等于「有效期由用户决定」，写 10 年也接受 |
| **3** | 必须校验 `status = 'active'`（顺带就查了账号行） | 管理员禁用了账号，对方拿已签发的 token 照样能用 |

#### 3.2.2 这套方案的已知风险（需求方知情后选定）

| 风险 | 说明 |
|---|---|
| **DB 泄露 = 可伪造任意账号** | 签名密钥就存在 `account.account_token` 里。拿到库 = 能签出任何人的 `auth_token`。**这比原来的会话表方案更严重**（原方案 DB 泄露只拿到不可用的摘要） |
| **本地 json 存 `account_token` = 存密码等价物** | 能读到 `~/.dsh/storages/teamwork/.credentials.json` 的人，可以直接签出任意时长的 token（受护栏 2 限制为 ≤3 天，但可以**反复续签**）⇒ 实际等价于永久凭据 |
| **「3 天过期」对持有 json 的人不成立** | 过期只对「只截获了某一次 auth_token 的人」有效；持密钥者可随时重签 |
| **无法单点吊销，也无法登出即失效** | `logout` 只清本地文件；要让服务端真正作废，只能**改密码**（`account_token` 变 ⇒ 所有已签发的 token 立即失效） |
| **IP 绑定默认关闭** | NAT / 代理 / 动态 IP 会误杀；开启后只作为弱信号 |

#### 3.2.3 这张表为什么能删（留档）

| # | 议题 | 结论 |
|---|---|---|
| C-1 | 为什么原来需要它 | 唯一用途是「记住发过哪些 token」以便**单点吊销**与**过期判定** |
| C-2 | 现在为什么不需要 | `exp` 写进 token 自校验、密钥由账号行提供、吊销改由「改密码」整体进行 |
| C-3 | 付出了什么 | 单设备吊销、设备列表（`created_ip`/`user_agent`）、`last_used_at` 观测，全部消失 |
| C-4 | 若日后要恢复单点吊销 | 重建会话表即可（原 9 列设计留在 git 历史里），但那时 token 要改回「服务端签发 + 存摘要」 |

### 3.3 没有 `whitelist` 表（原 `dsh_teamwork_whitelist` 已合并进 `account`）

**决策：全局角色不单独建表，直接是 `account.global_role` 一列。** 表数从 10 降到 9。

理由（逐条）：

| 独立角色表最初的理由 | 现在还成立吗 |
|---|---|
| 账号由外部系统统一分配，服务需要一个本地角色表 | ❌ 账号已经是我们自己注册的了，角色天然属于账号 |
| 需要在「账号还没注册」时先授权 | ⚠️ 唯一真实价值（预授权）。用**注册码**（`--registration-code`，一个配置值）替代，不需要一张表 |
| 允许一个账号没有角色行（默认 `user`） | ❌ 这是隐式默认，反而制造「账号存在但没角色」的边界态；改成列默认值 `'user'` 更干净 |
| 删人 = 删白名单行 | ❌ `account.status='disabled'` 已表达且更安全（保留 token 审计追溯） |

**合并带来的具体收益**

| 项 | 合并前 | 合并后 |
|---|---|---|
| 表数 | 10 | **9** |
| 鉴权 SQL | 两表 `LEFT JOIN` + `COALESCE(w.role,'user')` | **单表**，无默认值兜底 |
| 鉴权成本 | 1.85 µs（实测，含 JOIN） | 更低（单表单索引） |
| 首个用户 bootstrap | 事务里插两张表 | 一次 INSERT（`global_role='administrator'`） |
| 「账号存在但无角色行」 | 存在，靠 COALESCE 兜 | 不存在 |
| 管理接口 | `GET/POST/DELETE /admin/whitelist`（3 个） | `PUT /admin/accounts/{accountId}/role`（1 个） |

**注册准入怎么替代预授权**

| 方案 | 做法 | 表 |
|---|---|---|
| 默认开放 | 任何人都能注册，落 `global_role='user'`；管理员事后 `PUT .../role` 提升 | 需要 0 张表 |
| 关闭陌生人 | 配置 `--registration-code <secret>`：`POST /auth/register` 必须带 `X-Registration-Code`，否则 403 `registration_closed` | 0 张表，1 个配置值 |
| 完全关闭 | `--registration=closed`：只有 `POST /admin/accounts`（administrator 代人建号）能加人 | 0 张表 |

**「最后一个 administrator」的保护**（实测有效）：业务层 + `BEGIN IMMEDIATE` 事务

```
BEGIN IMMEDIATE;
  查目标当前 global_role
  若是 administrator 且 count(administrator)=1 且目标是降级/禁用/删除 → ROLLBACK，返回 409 last_administrator
  否则 UPDATE account SET global_role=?, updated_at=now WHERE account_id=?;
COMMIT;
```

> **不加 DB 触发器**：触发器会隐藏写入点，与「mapper 层是唯一碰 SQL 的地方」冲突；
> 且 `BEGIN IMMEDIATE` 已经把并发写串行化，业务层判定是安全的。

**角色集合**：`administrator` / `leader` / `user`（刻意不用 `manager`，避免与项目内角色撞名）。

| 值 | 语义 | 能建 `private` 项目 | 能建 `public` 项目 | 能调 `/admin/*` |
|---|---|---|---|---|
| `administrator` | 全权 | ✅（不限个数） | ✅ | ✅ |
| `leader` | 可建公共项目 | ✅ | ✅ | ❌ |
| `user` | 默认 | ✅（**≤5 成员**） | ❌ | ❌ |

**命名说明**：全局角色刻意用 `leader` 而不是 `manager` —— 项目成员表里已经有一个 `manager`
（表示「在这个项目里能管成员」，见 §3.5）。两套枚举分属不同域，代码里必须分开声明：
```ts
type GlobalRole  = 'administrator' | 'leader' | 'user'      // account.global_role
type ProjectRole = 'owner' | 'manager' | 'member'           // project_member.role（见 §3.5）
```

TS 下这是两个独立类型，跨域比较过不了编译；**禁止**把两个角色混进同一个变量或同一个判定函数。


文档里一律写「全局 `leader`」/「项目内 `manager`」，不混用。「项目 `owner`」指的是成员表的 `owner` 角色，不是全局角色。

**刻意不加** `readonly` / `guest`：每加一个值，所有权限判定都要多一个分支，而内网场景用不到
（要看只读，把人加进项目但不给管理权即可）。

### 3.4 `dsh_teamwork_project`（项目）

**8 列** / 2 索引 / 2 CHECK。**`owner` 列已删除**（负责人只存在 `project_member.role='owner'` 里）。

| # | 列 | 类型 | 空 | 默认 | 写入方 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | — | 主键（接口里的项目 `id`） |
| 2 | `name` | TEXT | 否 | — | 创建 | **全局唯一**，1..100 字符（`trim` 后） |
| 3 | `status` | TEXT | 否 | `'active'` | 归档/还原 | `active` / `archived`；**`archived` = 只读**，见 §3.4.2 |
| 4 | `visibility` | TEXT | 否 | `'public'` | 创建/修改 | `public`（成员不限）/ `private`（**成员上限 5**）；见 §3.4.1 |
| 5 | `description` | TEXT | 是 | — | 创建/修改 | |
| 6 | `created_by` | TEXT | 是 | — | 服务端填 | 创建人；请求里传了也会被覆盖；创建后不可改；**只作审计，不参与任何权限判定** |
| 7 | `created_at` | TEXT | 否 | `now` | — | |
| 8 | `updated_at` | TEXT | 否 | `now` | — | |

```sql
CREATE UNIQUE INDEX uk_tw_project_name    ON dsh_teamwork_project(name);
CREATE INDEX        idx_tw_project_updated ON dsh_teamwork_project(updated_at DESC);
CONSTRAINT ck_tw_project_name_len  CHECK (length(trim(name)) BETWEEN 1 AND 100)
CONSTRAINT ck_tw_project_visibility CHECK (visibility IN ('public','private'))
```

**`ProjectVo.owner` 变成派生字段**（接口形状不变，来源变了）：

```sql
-- 「负责人」= 成员表里 joined_at 最早的 owner；没有则 null
SELECT m.account_id
  FROM dsh_teamwork_project_member m
 WHERE m.project_id = ? AND m.role = 'owner'
 ORDER BY m.joined_at ASC, m.id ASC
 LIMIT 1;
```

> **为什么砍掉**：把「负责人」同时存在 `project.owner` 列和 `project_member.role='owner'` 行里，
> 实测改一处不同步另一处（改了列，成员表还是老 owner）→ 两个人都能删项目。
> 旧删项目判定要看 4 处（`administrator` → `owner` 字段 → `created_by` → 成员 `owner`/`creator`，其中后三个已全部取消）；
> 现在只剩 **2 处**：`administrator`，或成员 `role='owner'`。
> 「转让负责人」= 改成员角色（`POST /projects/{id}/members` upsert 一个 `role='owner'`），不需要改项目行。
> `created_by` **不再给删权**（否则又是第三处真相），只作审计。

#### 3.4.1 `private` 项目成员上限 = 5（`visibility` 的唯一真实语义）

| `visibility` | 成员上限 | 谁能建 |
|---|---|---|
| `public` | 不限 | 全局 `administrator` / `leader` |
| `private` | **5** | **任何登录用户** |

即「小项目自由、大项目要授权」。四条规则（均已实测）：

| # | 规则 | 结果 |
|---|---|---|
| 1 | private 加第 6 个成员 | `409 project_member_limit`，`details:{limit:5,current:5}` |
| 2 | 移除成员后可再加（**动态计数**，不是配额） | ✅ |
| 3 | `public → private` 时成员 >5 | `409 cannot_shrink_to_private`，`details:{current:N,limit:5}` |
| 3 | `private → public` | 永远允许（放宽） |

**这是跨行约束，DB 的 `CHECK` 表达不了**（`CHECK` 只能看当前行）。必须 service 层 + 事务：

```
BEGIN IMMEDIATE;
  SELECT COUNT(*) FROM dsh_teamwork_project_member WHERE project_id = ?;   -- 事务内取，防并发
  if (visibility = 'private' && count >= 5) → 409 project_member_limit
  INSERT INTO dsh_teamwork_project_member(...);
COMMIT;
```

**三个检查点，漏一个就能绕过**：

| 端点 | 检查 |
|---|---|
| `POST /projects/{id}/members` | 加人前计数（private 且已满 → 409） |
| `PUT /projects/{id}` | 改 `visibility` 为 `private` 前计数（>5 → 409） |
| `POST /projects` | 创建时创建人自动成为成员 `owner`，占 1 个名额 |

**配置**：`--private-member-limit`（默认 `5`）。调小不会自动踢人，只会让存量超额项目**无法再加人**。
#### 3.4.2 `archived` 的语义（不再是纯标签）

`status='archived'` = **只读项目**：

| 允许 | 禁止 |
|---|---|
| 查看详情、成员、issue、附件、评论（全部读） | 加/删成员、改 `visibility`/`name`/`description`、新建 issue、改 issue 状态 |
| `administrator` / 成员 `owner` 还原成 `active` | 普通成员还原 |

- 列表默认**排除** archived（`GET /projects?includeArchived=true` 才含）
- 归档/还原：`PUT /projects/{id}` 传 `status`（需 `administrator` 或成员 `owner`）
- 归档**不**影响 token、不影响已有 issue 的读取
- `status` 本身仍不加 DB CHECK（保留"以后可能加 `deleted` 之类"的余地），白名单在应用层

### 3.5 `dsh_teamwork_project_member`（项目成员）

**6 列** / **4 索引** / 1 CHECK / 1 外键（CASCADE）。刻意砍掉了 `display_name` / `dept` / `creator`。

| # | 列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | 主键 |
| 2 | `project_id` | INTEGER | 否 | — | **FK → `dsh_teamwork_project(id)` ON DELETE CASCADE** |
| 3 | `account_id` | TEXT | 否 | — | 成员账号（弱引用；**加成员时校验账号存在**，见 §3.5.2） |
| 4 | `role` | TEXT | 否 | `'member'` | `owner` / `manager` / `member`（**`creator` 已删**） |
| 5 | `joined_at` | TEXT | 否 | `now` | **首次**加入时间；upsert 不覆盖；列表按它升序 |
| 6 | `updated_at` | TEXT | 否 | `now` | |

```sql
CREATE UNIQUE INDEX uk_tw_member       ON dsh_teamwork_project_member(project_id, account_id);
-- 每个项目【恰好一个】owner（部分唯一索引，DB 强制）
CREATE UNIQUE INDEX uk_tw_member_owner ON dsh_teamwork_project_member(project_id) WHERE role = 'owner';
CREATE INDEX        idx_tw_member_acct ON dsh_teamwork_project_member(account_id);
CREATE INDEX        idx_tw_member_pid  ON dsh_teamwork_project_member(project_id);
CONSTRAINT ck_tw_member_role CHECK (role IN ('owner','manager','member'))
```

**为什么砍掉那三列**

| 砍掉 | 原因 |
|---|---|
| `display_name` | 与 `account.display_name` **双存储**（和刚砍掉的 `project.owner` 同一个病：改一处不同步另一处）。姓名统一从 `account` JOIN：`COALESCE(a.display_name, a.account_id)` |
| `dept` | **没有数据源**（没有外部人员信息可查），只能手填 → 长期为空 |
| `creator` | **从未被真正写入过**（创建人与 owner 都写 `owner`）；保留它只会让每个权限判定多一个分支 |

#### 3.5.1 owner 的四条硬规则（实测通过）

| # | 规则 | 由谁保证 |
|---|---|---|
| 1 | **每个项目恰好一个 `owner`**（不能两个，也不能没有） | **DB**：`uk_tw_member_owner ... (project_id) WHERE role='owner'` 部分唯一索引 |
| 2 | **`public` 项目的 owner 必须是全局 `leader` / `administrator`**；`private` 项目 owner 不限角色 | **service**（跨表 + 跨行，CHECK 表达不了） |
| 3 | **`owner` 不可通过成员接口授予**（成员接口只能给 `manager`/`member`） | **service**（`400 owner_role_not_assignable`） |
| 4 | **owner 不能被直接移除**，必须先转让 | **service**（`409 owner_cannot_be_removed`） |

#### 3.5.2 角色授予矩阵（谁能给谁什么角色）

| 操作者 | 可授予的角色 | 能否转让 owner |
|---|---|---|
| 全局 `administrator` | `manager` / `member` | ✅ |
| 该项目 **owner** | `manager` / `member` | ✅ |
| 该项目 `manager` | **仅 `member`** | ❌ |
| 该项目 `member` / 非成员 | — | ❌ |

> `owner` **不在任何"可授予角色"里** —— 它只能由「建项目（创建人）」或「转让」（`PUT /projects/{id}/owner`）产生。
> 这样避免"两个人互相把自己设成 owner"或"manager 提权成 owner"。

#### 3.5.3 转让 owner（专门接口，两步事务）

调用者：**全局 `administrator`** 或 **该项目当前 `owner`**；`public` 项目要求目标账号是 `leader`/`administrator`。

```sql
BEGIN IMMEDIATE;
  -- ① 先降旧 owner（否则新 owner 插入时两个 owner 同时存在 → UNIQUE 失败）
  UPDATE dsh_teamwork_project_member SET role='manager', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
   WHERE project_id=? AND role='owner' AND account_id<>?;
  -- ② 再升新 owner（upsert，允许目标原来就是成员，也可能需要先插一行）
  INSERT INTO dsh_teamwork_project_member(project_id, account_id, role) VALUES(?,?,'owner')
  ON CONFLICT(project_id, account_id) DO UPDATE SET role='owner', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now');
COMMIT;
```

**加入成员 / 改角色（成员接口，只能 manager/member）**

```sql
-- role 只允许 'manager' / 'member'（'owner' 由 service 层拒绝）
INSERT INTO dsh_teamwork_project_member(project_id, account_id, role)
VALUES (?, ?, ?)
ON CONFLICT(project_id, account_id) DO UPDATE SET
  role       = excluded.role,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');
-- 注意：ON CONFLICT 里【不改 joined_at】→ 移除后重新加入仍保留首次加入时间
```

### 3.6 `dsh_teamwork_device`（用户设备）

**9 列** / 4 索引 / 2 CHECK。

| # | 列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | 主键 |
| 2 | `account_id` | TEXT | 否 | — | 用户账号 |
| 3 | `host` | TEXT | 否 | — | hostname 或 IP |
| 4 | `port` | INTEGER | 否 | `0` | **未上报落 0**（唯一键必须可命中，`NULL` 无法命中） |
| 5 | `os` | TEXT | 是 | — | 操作系统 |
| 6 | `status` | TEXT | 否 | `'active'` | `active` / `inactive`（系统维护） |
| 7 | `last_active_at` | TEXT | 是 | — | 最后上报时间 |
| 8 | `created_at` | TEXT | 否 | `now` | |
| 9 | `updated_at` | TEXT | 否 | `now` | |

```sql
CREATE UNIQUE INDEX uk_tw_device       ON dsh_teamwork_device(account_id, host, port);
CREATE INDEX        idx_tw_device_acct ON dsh_teamwork_device(account_id);
CREATE INDEX        idx_tw_device_host ON dsh_teamwork_device(host);
CREATE INDEX        idx_tw_device_acct_st ON dsh_teamwork_device(account_id, status);
CONSTRAINT ck_tw_device_port   CHECK (port BETWEEN 0 AND 65535)
CONSTRAINT ck_tw_device_status CHECK (status IN ('active','inactive'))
```

**全量同步（两条语句，必须同事务）**

```sql
-- ① 该账号全部设备先标 inactive（不删，留历史）
UPDATE dsh_teamwork_device
   SET status = 'inactive', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
 WHERE account_id = ? AND status <> 'inactive';

-- ② 本次上报的设备 upsert 回 active（每 500 条一批）
INSERT INTO dsh_teamwork_device(account_id, host, port, os, status, last_active_at)
VALUES (?, ?, ?, ?, ?, 'active', strftime('%Y-%m-%dT%H:%M:%fZ','now')), ...
ON CONFLICT(account_id, host, port) DO UPDATE SET
  os                  = excluded.os,
  status              = 'active',
  last_active_at      = excluded.last_active_at,
  updated_at          = strftime('%Y-%m-%dT%H:%M:%fZ','now');
```

### 3.7 `dsh_teamwork_device_workspace`（设备工作区肖像）

**9 列** / **4 索引** / **2 CHECK**。**表名单数化**（命名统一）。

| # | 列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | 主键 |
| 2 | `account_id` | TEXT | 否 | — | 用户账号 |
| 3 | `instance` | TEXT | 否 | — | 实例标识 `ip:port`（= `device.host:port`） |
| 4 | `workspace_id` | TEXT | 是 | — | 工作区 id；**`type=index` 时必须 NULL** |
| 5 | `cwd` | TEXT | 是 | — | 工作区根目录；**`type=index` 时必须 NULL** |
| 6 | `type` | TEXT | 否 | — | `index` / `portal` |
| 7 | `detail` | TEXT | 否 | — | `index`：实例级项目索引 md；`portal`：该工作区肖像 md；**不限长度** |
| 8 | `created_at` | TEXT | 否 | `now` | |
| 9 | `updated_at` | TEXT | 否 | `now` | |

```sql
-- 两条部分唯一索引：index 行 workspace_id 是 NULL，NULL 互不相等，单条索引管不住
CREATE UNIQUE INDEX uk_tw_ws_portal ON dsh_teamwork_device_workspace(account_id, instance, workspace_id)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX uk_tw_ws_index  ON dsh_teamwork_device_workspace(account_id, instance)
  WHERE workspace_id IS NULL;

-- 复合索引的最左前缀已覆盖「按 account_id 查」，所以【不再单独建 idx_tw_ws_acct】（实测白建）
CREATE INDEX idx_tw_ws_acct_instance ON dsh_teamwork_device_workspace(account_id, instance);
-- 只服务 cwd 的【精确/范围】查询；LIKE '%x%' 与 LIKE 'x%' 都用不上它（实测 SCAN）
CREATE INDEX idx_tw_ws_cwd           ON dsh_teamwork_device_workspace(cwd);

CONSTRAINT ck_tw_ws_type CHECK (type IN ('index','portal'))
CONSTRAINT ck_tw_ws_shape CHECK (
     (type = 'index'  AND workspace_id IS NULL     AND cwd IS NULL)
  OR (type = 'portal' AND workspace_id IS NOT NULL AND cwd IS NOT NULL)
)
```

**upsert（两种形状各一条，实测幂等）**

```sql
-- index：同一实例重复上报只刷新 detail
INSERT INTO dsh_teamwork_device_workspace(account_id, instance, workspace_id, cwd, type, detail)
VALUES (?, ?, NULL, NULL, 'index', ?)
ON CONFLICT(account_id, instance) WHERE workspace_id IS NULL
DO UPDATE SET detail = excluded.detail, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');

-- portal：按 (账号, 实例, 工作区) 刷新 cwd + detail
INSERT INTO dsh_teamwork_device_workspace(account_id, instance, workspace_id, cwd, type, detail)
VALUES (?, ?, ?, ?, 'portal', ?)
ON CONFLICT(account_id, instance, workspace_id) WHERE workspace_id IS NOT NULL
DO UPDATE SET cwd = excluded.cwd, detail = excluded.detail,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now');
```

### 3.8 `dsh_teamwork_issue`（Issue 事件单）

**22 列** / **9 索引** / **5 CHECK**（含 `project_id` / `title` / `detail`）。

| # | 列 | 类型 | 空 | 默认 | 写入方 | 说明 |
|---|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | — | 库内主键（**跨实例不可移植，别做业务引用**） |
| 2 | `issue_id` | TEXT | 否 | — | 发布方 | **事件ID / 幂等键**，1..100 字符 |
| 3 | **`project_id`** | INTEGER | **是** | — | 发布方 | **归属项目**（`NULL` = 无项目的临时 issue）；弱引用 `project.id`，service 校验存在 + 成员身份 |
| 4 | **`title`** | TEXT | 否 | — | 发布方 | **标题**，1..200 字符（列表必须有它，不再从 JSON 里挖） |
| 5 | **`detail`** | TEXT | 是 | — | 发布方 | **正文/诉求原文**，不限长度 |
| 6 | `assigner` | TEXT | 否 | — | 发布方 | 下发人 |
| 7 | `assigner_task` | TEXT | 是 | — | 发布方 | 上游标识（DSH 里建议存**上游会话 id**） |
| 8 | `assigner_meta` | TEXT | 是 | — | 发布方 | 扩展 JSON（**不再承载 title/projectId**，二者已独立成列） |
| 9 | `cwd` | TEXT | 是 | — | 发布方 | 项目路径（≤500），跨实例定位用 |
| 10 | `urgency` | TEXT | 否 | `'normal'` | 发布方 | 5 值；应用层白名单 |
| 11 | `permission` | TEXT | 是 | — | 发布方 | 3 值；应用层白名单 |
| 12 | `assignee` | TEXT | 否 | — | 发布方 | 责任人账号 |
| 13 | `assignee_task` | TEXT | 是 | — | 执行方 | 下游标识（建议存**执行会话 id**） |
| 14 | `assignee_instance` | TEXT | 是 | — | 执行方 | 执行实例 `ip:port` |
| 15 | `assignee_meta` | TEXT | 是 | — | 执行方 | 输出 JSON |
| 16 | `status` | TEXT | 否 | `'pending'` | 双方 | 7 值状态机；应用层白名单 |
| 17 | `source` | TEXT | 否 | `'self'` | 发布方 | 来源 code（弱引用 `issue_source.code`） |
| 18 | `source_instance` | TEXT | 是 | — | 发布方 | 来源实例 |
| 19 | `depends_on` | TEXT | 是 | — | 发布方 | 依赖 issue 列表 JSON，服务端**不解析不校验** |
| 20 | `created_at` | TEXT | 否 | `now` | — | 上报时刻 |
| 21 | `assigned_at` | TEXT | 是 | — | 执行方 | 认领时刻；**只在目标 `status='routing'` 时写** |
| 22 | `updated_at` | TEXT | 否 | `now` | — | 最后写入 |

**三列新列的理由**

| 新列 | 为什么 |
|---|---|
| `project_id` | 项目有真实语义（owner/成员上限/归档），issue 不挂项目就**无法 JOIN 项目名、删项目会留下悬空引用**。把归属塞进 JSON 再靠表达式索引，约束全靠约定 |
| `title` | 列表必须有一行标题；从 JSON 里挖标题是反模式 |
| `detail` | 诉求正文（md 可以很长），单独成列后 `assigner_meta` 退化为纯扩展字段 |

```sql
CREATE UNIQUE INDEX uk_tw_issue_id ON dsh_teamwork_issue(issue_id);
CREATE INDEX idx_tw_issue_assignee          ON dsh_teamwork_issue(assignee);
CREATE INDEX idx_tw_issue_assignee_instance ON dsh_teamwork_issue(assignee_instance);
CREATE INDEX idx_tw_issue_assigner          ON dsh_teamwork_issue(assigner);
CREATE INDEX idx_tw_issue_assigner_task     ON dsh_teamwork_issue(assigner_task);
CREATE INDEX idx_tw_issue_assignee_task     ON dsh_teamwork_issue(assignee_task);
CREATE INDEX idx_tw_issue_status            ON dsh_teamwork_issue(status);
CREATE INDEX idx_tw_issue_source            ON dsh_teamwork_issue(source);
-- 项目归属：复合索引（过滤 + 排序一次走完）
CREATE INDEX idx_tw_issue_project ON dsh_teamwork_issue(project_id, created_at DESC);

CONSTRAINT ck_tw_issue_id_len  CHECK (length(issue_id) BETWEEN 1 AND 100)
CONSTRAINT ck_tw_issue_cwd_len CHECK (cwd IS NULL OR length(cwd) <= 500)
CONSTRAINT ck_tw_issue_title_len  CHECK (length(trim(title)) BETWEEN 1 AND 200)
CONSTRAINT ck_tw_issue_urgency   CHECK (urgency IN ('runtime','direct','urgent','normal','relaxed'))
CONSTRAINT ck_tw_issue_permission CHECK (permission IS NULL OR permission IN ('read-only','workspace-write','danger-full-access'))
```

**项目归属（`project_id` 列）**

| 规则 | 说明 |
|---|---|
| 可空 | `NULL` = 无项目的临时 issue（允许临时 issue）；有项目时必须传 |
| 写入校验 | `POST /issues/batch` 若传了 `project_id`：**校验项目存在**（404）、**调用者是该项目成员**（403）、**项目不是 `archived`**（409） |
| 查询 | `WHERE project_id = ? ORDER BY created_at DESC` —— 走 `idx_tw_issue_project`（复合，一次走完） |
| 删项目 | 删之前先查该项目的 issue 数；>0 则 **409 `project_has_issues`**（要求先归档或先改归属），避免悬空 |
| 与 `cwd` 的关系 | `project_id` 是业务归属（关系），`cwd` 是**执行定位**（跨实例找设备），两者并存不互斥 |
### 3.9 `dsh_teamwork_issue_attachment`（Issue 附件）

8 列 / 3 索引 / 1 CHECK。**只存关系，文件本体在磁盘**（`dataDir/files/<fileId>`）。

| # | 列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | 主键 |
| 2 | `issue_id` | TEXT | 否 | — | 弱引用 `issue.issue_id`（不校验存在） |
| 3 | `file_id` | TEXT | 否 | — | UUID v4，等于磁盘文件名；由 `POST /files` 产出 |
| 4 | `file_name` | TEXT | 是 | — | 原始文件名（下载时回 `Content-Disposition`） |
| 5 | `type` | TEXT | 否 | — | `assigner`（下发方提供）/ `assignee`（执行方交付） |
| 6 | `description` | TEXT | 是 | — | 说明 |
| 7 | `created_at` | TEXT | 否 | `now` | |
| 8 | `updated_at` | TEXT | 否 | `now` | |

```sql
CREATE UNIQUE INDEX uk_tw_attachment ON dsh_teamwork_issue_attachment(issue_id, file_id);
CREATE INDEX idx_tw_attachment_issue      ON dsh_teamwork_issue_attachment(issue_id);
CREATE INDEX idx_tw_attachment_issue_type ON dsh_teamwork_issue_attachment(issue_id, type);
CONSTRAINT ck_tw_attachment_type CHECK (type IN ('assigner','assignee'))

-- upsert：description 传空保留原值
INSERT INTO dsh_teamwork_issue_attachment(issue_id, file_id, file_name, type, description)
VALUES (?,?,?,?,?)
ON CONFLICT(issue_id, file_id) DO UPDATE SET
  file_name   = excluded.file_name,
  type        = excluded.type,
  description = COALESCE(excluded.description, description),
  updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now');
```

### 3.10 `dsh_teamwork_issue_comment`（Issue 评论）

10 列 / 2 索引 / 1 CHECK。**`id` 是全表的增量游标，所以必须 `AUTOINCREMENT`。**

| # | 列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | 主键（**增量游标**；删行后不复用，实测 2→删→3） |
| 2 | `comment_id` | TEXT | 否 | — | 评论业务键（UUID），幂等去重；客户端提供、重试不变 |
| 3 | `issue_id` | TEXT | 否 | — | 弱引用 |
| 4 | `author` | TEXT | 是 | — | 评论人；未传由服务端填调用者账号 |
| 5 | `content` | TEXT | 否 | — | 非空（CHECK） |
| 6 | `comment_role` | TEXT | 是 | — | `assigner`/`assignee`/NULL，**只存不校验** |
| 7 | `comment_author_type` | TEXT | 是 | — | `user`/`agent`/`system`/NULL，**只存不校验** |
| 8 | `comment_at` | TEXT | 否 | `now` | **评论发生时刻**（客户端可回填） |
| 9 | `created_at` | TEXT | 否 | `now` | 入库时刻 |
| 10 | `updated_at` | TEXT | 否 | `now` | |

```sql
CREATE UNIQUE INDEX uk_tw_comment_id ON dsh_teamwork_issue_comment(comment_id);
CREATE INDEX idx_tw_comment_issue    ON dsh_teamwork_issue_comment(issue_id);
CONSTRAINT ck_tw_comment_content CHECK (length(content) >= 1)

-- 幂等插入：重复 comment_id 返回 0 行
INSERT INTO dsh_teamwork_issue_comment(comment_id, issue_id, author, content,
                                       comment_role, comment_author_type, comment_at)
VALUES (?,?,?,?,?,?,COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')))
ON CONFLICT(comment_id) DO NOTHING;

-- 增量：主键范围扫，与表总量无关（游标必须用 id，不能用 comment_at/created_at）
SELECT * FROM dsh_teamwork_issue_comment WHERE id > ? ORDER BY id ASC LIMIT ?;

-- 游标初始化
SELECT COALESCE(MAX(id), 0) AS maxId FROM dsh_teamwork_issue_comment;
```

### 3.11 `dsh_teamwork_issue_source`（事件来源字典）

6 列 / 1 索引 / 1 CHECK。

| # | 列 | 类型 | 空 | 默认 | 说明 |
|---|---|---|---|---|---|
| 1 | `id` | INTEGER | 否 | 自增 | 主键 |
| 2 | `code` | TEXT | 否 | — | 来源编码，**小写英文字母 + 中划线**（`^[a-z]+(-[a-z]+)*$`，1..64）；被 `issue.source` 弱引用 |
| 3 | `description` | TEXT | 是 | — | 描述 |
| 4 | `plugin_name` | TEXT | 是 | — | 注册该来源的插件名 |
| 5 | `created_at` | TEXT | 否 | `now` | |
| 6 | `updated_at` | TEXT | 否 | `now` | |

```sql
CREATE UNIQUE INDEX uk_tw_source_code ON dsh_teamwork_issue_source(code);
-- 格式：只允许小写字母与小写中划线，且不能以 - 开头/结尾、不能出现 --
CONSTRAINT ck_tw_source_code CHECK (
     length(code) BETWEEN 1 AND 64
 AND code NOT GLOB '*[^a-z-]*'
 AND code NOT GLOB '-*'
 AND code NOT GLOB '*-'
 AND code NOT GLOB '*--*'
)

-- 批量注册：先按 code 去重（保留最后一条），再分批 upsert
INSERT INTO dsh_teamwork_issue_source(code, description, plugin_name) VALUES (?,?,?), ...
ON CONFLICT(code) DO UPDATE SET
  description = COALESCE(excluded.description, description),
  plugin_name = COALESCE(excluded.plugin_name, plugin_name),
  updated_at  = strftime('%Y-%m-%dT%H:%M:%fZ','now');
```

**预置 3 条**（`ON CONFLICT DO NOTHING`，重复执行不新增）：

| code | description |
|---|---|
| `self` | 本地 DSH 创建 |
| `dsh` | 项目组发起 |
| `im-group` | 即时通讯群发起 |

> 为什么必须先应用层去重：同一批 `INSERT … ON CONFLICT DO UPDATE` 里同一个 `code` 出现两次，
> 某些数据库会报 `ON CONFLICT DO UPDATE command cannot affect row a second time`；
> 本库不报错但只保留最后一次 —— **两条路径都不要依赖数据库行为**，先按 code 去重。

---

## 4. 完整可执行 DDL（`src/server/db/migrations/001_init.sql`）

> 以下内容已在 Node 24.19 + SQLite 3.53.3 上**整段执行通过**，§0 的所有验证都基于它。

```sql
-- dsh-teamwork · 001_init.sql
-- 目标：SQLite >= 3.35（依赖 RETURNING 与部分唯一索引）
-- 约定：所有时间列为 TEXT，UTC ISO-8601 毫秒；所有索引显式命名
-- 执行：BEGIN IMMEDIATE; <本文件>; PRAGMA user_version = 1; COMMIT;

CREATE TABLE dsh_teamwork_account (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id    TEXT NOT NULL,
  display_name  TEXT,
  account_token  TEXT NOT NULL,
  global_role    TEXT NOT NULL DEFAULT 'user',
  status        TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_account_id_len  CHECK (length(account_id) BETWEEN 3 AND 64),
  CONSTRAINT ck_tw_account_status  CHECK (status IN ('active','disabled')),
  CONSTRAINT ck_tw_account_role    CHECK (global_role IN ('administrator','leader','user')),
  CONSTRAINT ck_tw_account_token    CHECK (length(account_token) = 64
                                     AND account_token NOT GLOB '*[^0-9a-f]*')
);
CREATE UNIQUE INDEX uk_tw_account ON dsh_teamwork_account(account_id);



CREATE TABLE dsh_teamwork_project (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  visibility  TEXT NOT NULL DEFAULT 'public',
  description TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_project_name_len CHECK (length(trim(name)) BETWEEN 1 AND 100),
  CONSTRAINT ck_tw_project_visibility CHECK (visibility IN ('public','private'))
);
CREATE UNIQUE INDEX uk_tw_project_name    ON dsh_teamwork_project(name);
CREATE INDEX        idx_tw_project_updated ON dsh_teamwork_project(updated_at DESC);

CREATE TABLE dsh_teamwork_project_member (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER NOT NULL,
  account_id   TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT fk_tw_member_project FOREIGN KEY (project_id)
    REFERENCES dsh_teamwork_project(id) ON DELETE CASCADE,
  CONSTRAINT ck_tw_member_role CHECK (role IN ('owner','manager','member'))
);
CREATE UNIQUE INDEX uk_tw_member       ON dsh_teamwork_project_member(project_id, account_id);
-- 每个项目【恰好一个】owner（部分唯一索引，DB 强制）
CREATE UNIQUE INDEX uk_tw_member_owner ON dsh_teamwork_project_member(project_id) WHERE role = 'owner';
CREATE INDEX        idx_tw_member_acct ON dsh_teamwork_project_member(account_id);
CREATE INDEX        idx_tw_member_pid  ON dsh_teamwork_project_member(project_id);

CREATE TABLE dsh_teamwork_device (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id          TEXT NOT NULL,
  host                TEXT NOT NULL,
  port                INTEGER NOT NULL DEFAULT 0,
  os                  TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  last_active_at      TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_device_port   CHECK (port BETWEEN 0 AND 65535),
  CONSTRAINT ck_tw_device_status CHECK (status IN ('active','inactive'))
);
CREATE UNIQUE INDEX uk_tw_device         ON dsh_teamwork_device(account_id, host, port);
CREATE INDEX        idx_tw_device_acct    ON dsh_teamwork_device(account_id);
CREATE INDEX        idx_tw_device_host    ON dsh_teamwork_device(host);
CREATE INDEX        idx_tw_device_acct_st ON dsh_teamwork_device(account_id, status);

CREATE TABLE dsh_teamwork_device_workspace (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id   TEXT NOT NULL,
  instance     TEXT NOT NULL,
  workspace_id TEXT,
  cwd          TEXT,
  type         TEXT NOT NULL,
  detail       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_ws_type CHECK (type IN ('index','portal')),
  CONSTRAINT ck_tw_ws_shape CHECK (
       (type = 'index'  AND workspace_id IS NULL     AND cwd IS NULL)
    OR (type = 'portal' AND workspace_id IS NOT NULL AND cwd IS NOT NULL)
  )
);
CREATE UNIQUE INDEX uk_tw_ws_portal   ON dsh_teamwork_device_workspace(account_id, instance, workspace_id)
  WHERE workspace_id IS NOT NULL;
CREATE UNIQUE INDEX uk_tw_ws_index    ON dsh_teamwork_device_workspace(account_id, instance)
  WHERE workspace_id IS NULL;
CREATE INDEX        idx_tw_ws_acct_instance ON dsh_teamwork_device_workspace(account_id, instance);
CREATE INDEX        idx_tw_ws_cwd           ON dsh_teamwork_device_workspace(cwd);

CREATE TABLE dsh_teamwork_issue (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id          TEXT NOT NULL,
  project_id        INTEGER,
  title             TEXT NOT NULL,
  detail            TEXT,
  assigner          TEXT NOT NULL,
  assigner_task     TEXT,
  assigner_meta     TEXT,
  cwd               TEXT,
  urgency           TEXT NOT NULL DEFAULT 'normal',
  permission        TEXT,
  assignee          TEXT NOT NULL,
  assignee_task     TEXT,
  assignee_instance TEXT,
  assignee_meta     TEXT,
  status            TEXT NOT NULL DEFAULT 'pending',
  source            TEXT NOT NULL DEFAULT 'self',
  source_instance   TEXT,
  depends_on        TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  assigned_at       TEXT,
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_issue_id_len  CHECK (length(issue_id) BETWEEN 1 AND 100),
  CONSTRAINT ck_tw_issue_cwd_len CHECK (cwd IS NULL OR length(cwd) <= 500),
  CONSTRAINT ck_tw_issue_title_len  CHECK (length(trim(title)) BETWEEN 1 AND 200),
  CONSTRAINT ck_tw_issue_urgency   CHECK (urgency IN ('runtime','direct','urgent','normal','relaxed')),
  CONSTRAINT ck_tw_issue_permission CHECK (permission IS NULL OR permission IN ('read-only','workspace-write','danger-full-access'))
);
CREATE UNIQUE INDEX uk_tw_issue_id           ON dsh_teamwork_issue(issue_id);
CREATE INDEX        idx_tw_issue_assignee          ON dsh_teamwork_issue(assignee);
CREATE INDEX        idx_tw_issue_assignee_instance ON dsh_teamwork_issue(assignee_instance);
CREATE INDEX        idx_tw_issue_assigner          ON dsh_teamwork_issue(assigner);
CREATE INDEX        idx_tw_issue_assigner_task     ON dsh_teamwork_issue(assigner_task);
CREATE INDEX        idx_tw_issue_assignee_task     ON dsh_teamwork_issue(assignee_task);
CREATE INDEX        idx_tw_issue_status            ON dsh_teamwork_issue(status);
CREATE INDEX        idx_tw_issue_source            ON dsh_teamwork_issue(source);
CREATE INDEX        idx_tw_issue_project          ON dsh_teamwork_issue(project_id, created_at DESC);

CREATE TABLE dsh_teamwork_issue_attachment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id    TEXT NOT NULL,
  file_id     TEXT NOT NULL,
  file_name   TEXT,
  type        TEXT NOT NULL,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_attachment_type CHECK (type IN ('assigner','assignee'))
);
CREATE UNIQUE INDEX uk_tw_attachment             ON dsh_teamwork_issue_attachment(issue_id, file_id);
CREATE INDEX        idx_tw_attachment_issue      ON dsh_teamwork_issue_attachment(issue_id);
CREATE INDEX        idx_tw_attachment_issue_type ON dsh_teamwork_issue_attachment(issue_id, type);

CREATE TABLE dsh_teamwork_issue_comment (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  comment_id          TEXT NOT NULL,
  issue_id            TEXT NOT NULL,
  author              TEXT,
  content             TEXT NOT NULL,
  comment_role        TEXT,
  comment_author_type TEXT,
  comment_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_comment_content CHECK (length(content) >= 1)
);
CREATE UNIQUE INDEX uk_tw_comment_id  ON dsh_teamwork_issue_comment(comment_id);
CREATE INDEX        idx_tw_comment_issue ON dsh_teamwork_issue_comment(issue_id);

CREATE TABLE dsh_teamwork_issue_source (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL,
  description TEXT,
  plugin_name TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CONSTRAINT ck_tw_source_code CHECK (
       length(code) BETWEEN 1 AND 64
   AND code NOT GLOB '*[^a-z-]*'
   AND code NOT GLOB '-*'
   AND code NOT GLOB '*-'
   AND code NOT GLOB '*--*'
  )
);
CREATE UNIQUE INDEX uk_tw_source_code ON dsh_teamwork_issue_source(code);

INSERT INTO dsh_teamwork_issue_source (code, description) VALUES
  ('self',   '本地 DSH 创建'),
  ('dsh',    '项目组发起'),
  ('im-group', '即时通讯群发起')
ON CONFLICT (code) DO NOTHING;

PRAGMA user_version = 1;
```

---

## 5. 枚举与 CHECK 总表

| 表.列 | 取值 | DB CHECK | 应用层白名单 | 谁改 |
|---|---|---|---|---|
| `account.status` | `active` / `disabled` | ✅ | ✅ | 管理 |
| `account.global_role` | `administrator` / `leader` / `user` | ✅ | ✅ | 注册/管理 |
| `project.status` | `active` / `archived` | ❌ | ✅ | 归档/还原；`archived` = 只读（§3.4.2） |
| `project.visibility` | `public` / `private` | ✅ | ✅ | 创建/修改；**`private` 触发成员上限 5**（§3.4.1） |
| `project_member.role` | `owner` / `manager` / `member` | ✅ | ✅ | `owner` 只能由建项目/转让产生（§3.5.2） |
| `device.status` | `active` / `inactive` | ✅ | — | 系统 |
| `device_workspace.type` | `index` / `portal` | ✅ | ✅ | 上报 |
| `issue.status` | `pending` / `accepted` / `routing` / `running` / `success` / `failed` / `abandoned` | ❌ | ✅ | 双方 |
| `issue.urgency` | `runtime` / `direct` / `urgent` / `normal` / `relaxed` | ✅ | ✅ | 发布方（**封闭枚举**，5 值） |
| `issue.permission` | `read-only` / `workspace-write` / `danger-full-access` | ✅ | ✅ | 发布方（**封闭枚举**，3 值；= DSH `SandboxMode`） |
| `issue.source` | 开放取值（预置 `self`/`dsh`/`im-group`） | ❌ | ❌ | 发布方 |
| `issue_attachment.type` | `assigner` / `assignee` | ✅ | ✅ | 挂附件 |
| `issue_comment.comment_role` | `assigner` / `assignee` / NULL | ❌ | ❌（只存不校验） | 客户端自证 |
| `issue_comment.comment_author_type` | `user` / `agent` / `system` / NULL | ❌ | ❌（只存不校验） | 客户端自证 |

**19 个 CHECK 全清单**：`ck_tw_account_id_len`、`ck_tw_account_status`、`ck_tw_account_token`、
`ck_tw_account_role`、`ck_tw_project_name_len`、`ck_tw_project_visibility`、`ck_tw_member_role`、`ck_tw_device_port`、
`ck_tw_device_status`、`ck_tw_ws_type`、`ck_tw_ws_shape`、`ck_tw_issue_id_len`、`ck_tw_issue_cwd_len`、`ck_tw_issue_title_len`、`ck_tw_issue_urgency`、`ck_tw_issue_permission`、
`ck_tw_attachment_type`、`ck_tw_comment_content`、`ck_tw_source_code`。

---

## 6. 索引汇总（30 个）

| # | 表 | 索引 | 类型 | 列 |
|---|---|---|---|---|
| 1 | account | `uk_tw_account` | 唯一 | `account_id` |
| 2 | project | `uk_tw_project_name` | 唯一 | `name` |
| 3 | project | `idx_tw_project_updated` | 普通 | `updated_at DESC` |
| 4 | project_member | `uk_tw_member` | 唯一 | `project_id, account_id` |
| 5 | project_member | `uk_tw_member_owner` | 唯一·部分 | `project_id` WHERE `role='owner'` |
| 6 | project_member | `idx_tw_member_acct` | 普通 | `account_id` |
| 7 | project_member | `idx_tw_member_pid` | 普通 | `project_id` |
| 8 | device | `uk_tw_device` | 唯一 | `account_id, host, port` |
| 9 | device | `idx_tw_device_acct` | 普通 | `account_id` |
| 10 | device | `idx_tw_device_host` | 普通 | `host` |
| 11 | device | `idx_tw_device_acct_st` | 普通 | `account_id, status` |
| 12 | device_workspace | `uk_tw_ws_portal` | 唯一·部分 | `account_id, instance, workspace_id` WHERE `workspace_id IS NOT NULL` |
| 13 | device_workspace | `uk_tw_ws_index` | 唯一·部分 | `account_id, instance` WHERE `workspace_id IS NULL` |
| 14 | device_workspace | `idx_tw_ws_acct_instance` | 普通 | `account_id, instance` |
| 15 | device_workspace | `idx_tw_ws_cwd` | 普通 | `cwd` |
| 16 | issue | `uk_tw_issue_id` | 唯一 | `issue_id` |
| 17 | issue | `idx_tw_issue_assignee` | 普通 | `assignee` |
| 18 | issue | `idx_tw_issue_assignee_instance` | 普通 | `assignee_instance` |
| 19 | issue | `idx_tw_issue_assigner` | 普通 | `assigner` |
| 20 | issue | `idx_tw_issue_assigner_task` | 普通 | `assigner_task` |
| 21 | issue | `idx_tw_issue_assignee_task` | 普通 | `assignee_task` |
| 22 | issue | `idx_tw_issue_status` | 普通 | `status` |
| 23 | issue | `idx_tw_issue_source` | 普通 | `source` |
| 24 | issue | `idx_tw_issue_project` | 普通·复合 | `project_id, created_at DESC` |
| 25 | issue_attachment | `uk_tw_attachment` | 唯一 | `issue_id, file_id` |
| 26 | issue_attachment | `idx_tw_attachment_issue` | 普通 | `issue_id` |
| 27 | issue_attachment | `idx_tw_attachment_issue_type` | 普通 | `issue_id, type` |
| 28 | issue_comment | `uk_tw_comment_id` | 唯一 | `comment_id` |
| 29 | issue_comment | `idx_tw_comment_issue` | 普通 | `issue_id` |
| 30 | issue_source | `uk_tw_source_code` | 唯一 | `code` |

**为什么 `idx_tw_issue_project` 是复合的**：只建 `(project_id)` 只能过滤、排序还得建临时 B 树（实测
`USE TEMP B-TREE FOR ORDER BY`）；加上 `created_at DESC` 后计划里只剩 `SEARCH ... USING INDEX`，
`COUNT(*)` 还走了 `COVERING INDEX`。

---

## 7. 设计取舍记录（为什么长这样）

| # | 决策 | 理由 |
|---|---|---|
| 1 | 表前缀统一 `dsh_teamwork_` | 与同库其它业务隔离；备份、清理、迁移时可用前缀精确圈定 |
| 2 | 账号列统一叫 `account_id` | 模块 A 的概念是 account，全库跟随，避免 `user_id`/`account_id` 混用 |
| 3 | 表名一律单数 | 命名统一（`device_workspace` 而不是 `device_workspaces`） |
| 4 | **9 张表** | 不设会话表（无状态 JWT）；不设独立角色表（角色并入 `account.global_role`） |
| 5 | 列前缀 `tw_` 只出现在索引/约束名 | 表名已带前缀，列名再加前缀只会让 SQL 变长 |
| 6 | 时间统一 UTC ISO-8601 TEXT | 一种格式、字典序 = 时间序、无需时区函数 |
| 7 | 枚举一律用 CHECK 兜底（系统维护的） | 服务端有 bug 时也写不进非法值；扩值需迁移是**有意**的成本 |
| 8 | 长度/格式护栏尽量下沉到 CHECK | 密码、UUID、source code、文件名这类「格式契约」不该只靠应用层 |
| 9 | `account_token` 的 CHECK 强制 64 位小写 hex | 它同时是签名密钥，格式错等于鉴权全崩 |
| 10 | `device.port` 建表即 `NOT NULL DEFAULT 0` + 范围 CHECK | 唯一键必须可命中，`NULL` 无法命中 |
| 11 | `issue_comment.id` 显式 `AUTOINCREMENT` | 增量游标依赖「删行后不复用 id」 |
| 12 | 索引名显式（`uk_tw_*` / `idx_tw_*`） | 不用内联 `UNIQUE`（会生成 `sqlite_autoindex_*`，与文档对不上） |
| 13 | `issue` 带 `project_id`（可空）+ 复合索引 | 项目有真实语义，issue 不挂项目无法 JOIN、删项目会悬空 |
| 14 | `project_member.role` 只留 `owner`/`manager`/`member` | 每多一个值，所有权限判定多一个分支 |
| 15 | 全库只有 1 个外键 | 只有「项目没了成员必须跟着没」是强一致；其余用弱引用 + 服务层校验 |
| 16 | `issue.depends_on` 不建索引 | 原样存取、服务端不解析，查询用不到索引 |

---

## 8. 迁移与运维

| 项 | 做法 |
|---|---|
| 版本号 | `PRAGMA user_version`（本次 `= 1`） |
| 文件 | `src/server/db/migrations/NNN_<name>.sql`，按文件名排序执行 |
| 事务 | 每个迁移文件包在 `BEGIN IMMEDIATE … COMMIT` 里；失败整体回滚且**不推进** `user_version` |
| 幂等 | 迁移只跑一次（由 `user_version` 保证）；**预置数据**用 `ON CONFLICT DO NOTHING` 兜底重复执行 |
| `PRAGMA foreign_keys` | 连接初始化时设；**不在迁移事务里设**（事务内无效） |
| 备份 | 停机后复制 `teamwork.db`（+`-wal`/`-shm`）；或 `VACUUM INTO 'backup.db'`（热备） |
| 健康检查 | `/health` 返回 `{path, userVersion, journalMode}`；`doctor` 额外跑 `PRAGMA integrity_check` |
| 升级路径 | 未来加列用 `ALTER TABLE … ADD COLUMN`（SQLite 支持）；**不支持**改列类型/删列，需要重建表时按「建新表→迁数据→改名」三段式 |

---

## 9. 常用查询

```sql
-- 1) 拉待认领（跨实例轮询，本人）
SELECT * FROM dsh_teamwork_issue
 WHERE assignee = ? AND status = 'pending'
 ORDER BY created_at ASC LIMIT 50;

-- 2) 某实例手上的活
SELECT * FROM dsh_teamwork_issue
 WHERE assignee_instance = ? AND status IN ('accepted','routing','running')
 ORDER BY updated_at DESC;

-- 3) 我的全部 issue（按 token 身份：assignee 或 assigner）
SELECT * FROM dsh_teamwork_issue
 WHERE (assignee = ? OR assigner = ?) AND (? IS NULL OR status = ?)
 ORDER BY created_at DESC LIMIT ? OFFSET ?;

-- 4) 某项目下的 issue（project_id 复合索引）
SELECT * FROM dsh_teamwork_issue
 WHERE project_id = ?
 ORDER BY created_at DESC LIMIT ? OFFSET ?;

-- 5) 血缘反查
SELECT * FROM dsh_teamwork_issue WHERE assigner_task = ?;   -- 某 task 拆出的 issue
SELECT * FROM dsh_teamwork_issue WHERE assignee_task = ?;   -- 某 task 由哪条 issue 转换

-- 6) 评论增量 + 游标
SELECT * FROM dsh_teamwork_issue_comment WHERE id > ? ORDER BY id ASC LIMIT ?;
SELECT COALESCE(MAX(id), 0) AS maxId FROM dsh_teamwork_issue_comment;

-- 7) 我参与的项目 + 成员数
SELECT p.*, (SELECT COUNT(*) FROM dsh_teamwork_project_member m WHERE m.project_id = p.id) AS member_count
  FROM dsh_teamwork_project p
 WHERE p.id IN (SELECT project_id FROM dsh_teamwork_project_member WHERE account_id = ?)
 ORDER BY p.updated_at DESC;

-- 8) 我在线设备 / 历史设备
SELECT * FROM dsh_teamwork_device WHERE account_id = ? AND status = 'active' ORDER BY last_active_at DESC;
SELECT * FROM dsh_teamwork_device WHERE account_id = ? ORDER BY status, id;

-- 9) 跨实例找项目所在工作区（分发前）
SELECT account_id, instance, workspace_id, cwd
  FROM dsh_teamwork_device_workspace
 WHERE cwd = ? AND type = 'portal';   -- 精确匹配（走索引）；前缀用 cwd >= ? AND cwd < ?

-- 10) 某实例的项目索引
SELECT * FROM dsh_teamwork_device_workspace
 WHERE account_id = ? AND instance = ? AND workspace_id IS NULL;

-- 11) 权限判定（最热）
SELECT role FROM dsh_teamwork_project_member WHERE project_id = ? AND account_id = ?;
SELECT global_role FROM dsh_teamwork_account WHERE account_id = ?;

-- 12) 自检
SELECT status, COUNT(*) FROM dsh_teamwork_issue GROUP BY status ORDER BY 2 DESC;
SELECT global_role, COUNT(*) FROM dsh_teamwork_account GROUP BY global_role;
SELECT code,   COUNT(*) FROM dsh_teamwork_issue_source GROUP BY code;
```

---

## 10. 待确认（都是表结构层面的，改起来有迁移成本，所以先问）

1. **`account` 要不要 `email` / `avatar`**：当前只有 `account_id` + `display_name`。要加就趁 `user_version=1` 还没上线加。
2. **`issue_comment.author` 是否允许空**：我按「客户端不传则由服务端填当前账号」写，列可空以兼容「系统生成的评论」。
   若要强制非空，改成 `NOT NULL` 更严格。
3. **授权审计**：角色现在在 `account.global_role`，若要记「谁授的权、何时」，需要加 `role_granted_by` / `role_granted_at` 两列（合并 `whitelist` 时一起砍掉了，现在加还来得及）。
4. **是否需要 `dsh_teamwork_audit_log`**：登录、角色变更、密码重置这些要不要留痕。本期没建表。

**已确认关闭的**（原待确认项，现已落进表结构）：

| 原问题 | 结论 |
|---|---|
| issue 的项目归属靠 `assigner_meta.$.projectId` 约定 | **已关闭**：新增 `project_id` 列（可空）+ `idx_tw_issue_project(project_id, created_at DESC)`，见 §3.8 / §7.4 |
| `issue` 没有标题/正文列 | **已关闭**：新增 `title`（必填 1..200）/ `detail`（不限长度） |
