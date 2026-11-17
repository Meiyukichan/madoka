# 06 · c/d/e 三份 raw 的遗漏复核（core + interactions）

> 只读复核：逐节重读 `docs/raw/{c,d,e}.md`，对照 `src/core/{logger,crypto,router,net,pricing}.ts`、`src/interactions/{route,collect,ownership}.ts`、`src/sessions/{questions,approval}.ts`、`src/shared/wire.ts`、`src/client/panel/{transport,Card}.ts*`。未改源码/测试、未跑测试。已核对过的项见 `05-conformance-core-utils.md` / `05-conformance-interactions.md`，下表只写它们没抓到的。

## 结论
- 真遗漏 **7** / 已覆盖 **10** / 有意不做 **6**
- 一句话：有，且有两类是用户/攻击者能直接看到的 —— ①诊断日志的 **cookie 脱敏只抹到第一个空白**，尾部凭据随 bug 报告外发；②出站代理把 `http_proxy` 与 `https_proxy` **合并成一个值**，企业内网 http 流量会走错代理。其余 5 条是低危的边界/文案/审计差异。

## 真遗漏（按严重度）

| # | 原始要求（raw 文件:行号 + 原文 ≤30 字） | 现实现（文件:行 + 现状） | 为什么算遗漏 | 最小修法 |
|---|---|---|---|---|
| N1 | c.md:182「`(cookie\|set-cookie)` + 分隔符 + **余下内容** → `$1$2***`」 | logger.ts:69 用 `\S+`：`cookie: a=1; b=2` → `cookie: ***; b=2` | 规则 7 的对象正是 credential-resolver 拼出的整条 cookie（c.md:182 原文注明），第 2 个 cookie/csrftoken 原样进 NDJSON 与 `exportLogs` | `\S+` 改 `[^\r\n]*`；补「多 cookie 串整条被抹」断言 |
| N2 | c.md:497-499「`https:` 走 https_proxy…；`http:` 走 http_proxy…」 | net.ts:91-103 只取 `proxyFromEnv().https`，并把同一值同时传给 `httpProxy`/`httpsProxy`（net.ts:70-75 算出的 `.http` 从未被消费） | 两值不同时（常见：http_proxy 与 https_proxy 分设）http:// 出站被送进 https 代理 → 拒连/被记录/审计地址错 | `dispatcherFor` 取 `{http,https}` 分别传入；undici `EnvHttpProxyAgent` 本就分档（node_modules/undici/lib/dispatcher/env-http-proxy-agent.js:31-38） |
| N3 | c.md:211「`trimAsync()`…**从尾往前累加行**，直到字节数达到 cap 的一半」 | logger.ts:194 `text.slice(text.length - target)` 按字节硬切 | 周文件超 256 KiB 后首行被截半，周文件首条是残片；`readPersistentLog` 不校验 JSON，坏行直接进导出文本 | 切点对齐到其后第一个 `\n`；补「trim 后首行可 JSON.parse」断言 |
| N4 | c.md:433「取值经 `decodePathSegment`（解码失败**保留原文**）」（待人工确认） | router.ts:337-341 解码失败即 `ok=false` → 整条不匹配 → 404 | 与 c.md 相反，也与 `05-conformance` G2 修复记录「safeDecode 保留原语义继续服务 matchRoute」自陈相反；无测试 | 恢复 `safeDecode(actual) ?? actual`；或把 c.md/05 的口径改成「解码失败即不匹配」并补断言（二者择一） |
| N5 | d.md:443「`selected` **允许空数组**（只校验 `Array.isArray` + 元素类型）」+ d.md:437-441 消息表 | route.ts:111 放行 `selected: ['']`/未知题 id；questions.ts:387-392 再拦一次并返回 `invalid-answer` → route.ts:164 落成通用 400 | 过了路由闸门的请求仍被库层拒，文案退化为 `the interaction was not answered: invalid-answer`，客户端无法区分「形状错」与「题不存在」 | 库层结果带原因（`invalid-answer:<reason>`）或 route 与库层共用同一套校验/文案 |
| N6 | d.md:86「浏览器侧**一个解包函数通吃**」 | transport.ts:35-39 `unwrap` 直接 `response.json()`，不看 `response.ok`；405 是空体（router.ts:59-61），e.md:667 承认的 webserver 裸 400 也无信封 | 卡片显示 `Unexpected end of JSON input`，而不是错误码（用户可见） | 先判 `response.ok === false`，`json()` 失败时兜底成 `{code:'http_'+status}` |
| N7 | b.md:607/623「没有『确认执行 / 拒绝 / 去聊天』三个按钮」→ 要求按 `intent` 分流（待人工确认：素材在本次三文件之外） | Card.tsx:166-167 只渲染「计划评审」徽标、:210-213 把 `intent.approve` 指向的选项标「推荐」；拒绝只能靠 asker 自带的选项 | d/e 只约定透传（d.md:185「plan-review 时 detail 即计划 markdown」），三分支面板本身仍缺 | 在 `plan-review` 分支按 `intent.approve` 渲染三按钮（批准/拒绝/去聊天），不透传也可由 host 合成选项 |

## 已覆盖核对（抽样 10 条）

| 维度 | raw | 实现 |
|---|---|---|
| 周轮转 + 保留 4 周 + 256 KiB/周（**点 1 结论：保留策略并非只做了追加写**） | c.md:165-166、192-207 | logger.ts:44-51、149-196（`KEEP_WEEKS=4`、`LOG_FILE_PATTERN` 只删自己的文件、`trimAsync` 超限重写） |
| 内存 200 条 + detail 600 截断 | c.md:163-164 | logger.ts:42-43、228、231 |
| 写盘失败一次即熔断 + 批次回放不丢 | c.md:223-224 | logger.ts:207-213 |
| 密钥 = 32B 随机 + `0600` + `flag:'wx'` + `EEXIST` 重读赢家（**点 2：raw 无 scrypt/派生要求**） | c.md:290-295 | crypto.ts:96-109 |
| 解密不建 key、认证失败返回原密文（契约 `===` 判定） | c.md:321-329 | crypto.ts:147-163 |
| method 归一（大小写）+ 三条固定文案 | c.md:405、468-472 | router.ts:148/367/382、271、278、285、289 |
| body 上限默认 8192 / interactions 64 KiB + content-type 闸 | c.md:421 | router.ts:363、268-292；route.ts:28、269 |
| 代理顺序（小写优先 / `npm_config_*` / 空值视未设 / `NO_PROXY` 交 undici）（**点 5：选择顺序对**） | c.md:494-506、993 | net.ts:63-75；undici env-http-proxy-agent.js:113 读 `no_proxy` env |
| 默认超时 30 s；`insecureFetch` 无超时且恒直连 | c.md:529、537-540 | net.ts:82、116、132-135 |
| 信封字段名 + 5 个错误码 + 状态码映射（200/400/403/404/409/405/413/415）+ 幂等 404 / 会话没了 409（**点 6、点 10 的 host 侧**） | d.md:86、446-457 | wire.ts:98-100；route.ts:141-166；questions.ts:248、409；approval.ts:220 |

## 有意不做（附理由）

- **AAD 绑定 / 密文版本前缀 / 解密失败错误码 / scrypt 参数**（点 2 四问）：c.md:337 明写「AAD **未使用**」；c.md:327-329 定「解密永不抛错、返回原密文，调用方用 `===` 判定」，无错误码是契约本身；key 是 32 字节**随机**（c.md:272），不存在派生参数；版本前缀被 c.md:973 列为"将来加算法时"的约束，现格式靠 DPAPI→段数自识别（crypto.ts:140-152）。
- **http-route 的读体超时 / 入站并发上限**（点 4 两问）：c.md 全文未要求；并发限制只针对**出站**（c.md:554-559 `createLimitedFetch`）。slowloris 归 webserver/部署层。
- **proxy-fetch 重试**（点 5 追问）：c.md 无 retry 要求（"不制造重试风暴"只针对 logger 落盘，c.md:224）。
- **pricing 的币种/四舍五入/未知模型兜底**（点 3）：c.md:655 只把 pricing 列进「未使用的 dsh 组件」，**没有任何原始要求**，无从判"缺"。现状供决策：元/百万 token、不四舍五入（浮点直加，pricing.ts:117）、未知模型回退 deepseek-flash（pricing.ts:95-103）、坏表→空表→账单 0（pricing.ts:56-63）。是否补素材**待人工确认**。
- **「谁批了什么」的 actor 审计**（点 9）：e.md:483-484 的审计由 dsh 自身 `approval/asked` / `approval/decided` 承担，旧实现 只镜像成 `ApprovalRecord`（core.ts:88-95、484-511）；提问侧 dsh 零日志，故自记 `question.*`（questions.ts:82-88、218-228）。HTTP 面无身份模型 → 没有"谁"可记；只缺"经 HTTP 面结算"这一动作行（点 9 唯一可补项，非 raw 要求）。
- **双击重复提交**（点 10）：e.md:629 认定「第二次 404 是幂等失败，符合预期」；卡片 busy 期间按钮 `disabled`（Card.tsx:225、355-360），host 侧二次应答恒 404/409（questions.ts:248、409）。
