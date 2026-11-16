# 05 · core-utils 一致性核对（G2 · C-001…C-208）

- 核对方式：**只读**。逐条读 `src/core/{logger,crypto,router,net}.ts`（`pricing.ts` 不在 208 条范围内）+ `tests/core/*.test.ts`，未改任何源码、未跑测试。
- 证据约定：源码路径均相对 `src/core/`；测试用 `tests/core/` 里的 `it()` 名字（不写行号，避免与并发编辑冲突）。
- 基数：**208 条**。统计：**✅一致 199 / ⚠️有差异 6 / ❌缺失 0 / ✅有意差异 3**（199+6+0+3 = 208）。
- ⚠️ 清单：C-035、C-044、C-049、C-096、C-120、C-198。
- ✅有意差异清单：C-042、C-132、C-205（判据见下条）。
- 判定口径：状态比的是**代码可观测行为/形状**。只有"c.md 原文并不禁止、且设计文档明示有意"才记 `✅有意差异`；**凡 c.md 原文明确要求相反行为的，一律记 ⚠️**，即使 `01-core-utils.zh.md §7` 声明过"有意"。
- 白名单命中情况：`00-overview.zh.md` §3.8 的 5 条真机问题、§5 的 26 条适配项**全部落在 sessions / interactions / client**，core-utils 这 208 条**一条也没被白名单覆盖**；`01-core-utils.zh.md §7` 自陈的 4 处行为变更（dispose 同步落盘、`trustedHosts`、dispose 后 fetch 抛错、pluginName 校验）按上述口径分别落到 C-035（⚠️）、C-132（有意）、C-205（有意）、C-042（有意）。
- 快照时间：2026-11-15 17:20（`logger.ts` 304 行 / `logger.test.ts` 112 行；核对期间这两份文件被并发修改过，本表按修改后的版本判定。sanitize 规则 9/10 现已调成"身份证先于手机号"，见 C-027/C-028/C-030）。
- 交叉事实：`tests/core/` **没有 `net.test.ts`**（proxy-fetch 34 条全无单测），logger/router/crypto 也只覆盖了部分契约——见 GAPS 末尾附录。

## 逐条判定（C-001…C-208）

| ID | 状态 | 证据（src 文件:行号 或 test 名） | 差异说明（仅 ⚠️/❌ 填） |
|---|---|---|---|
| C-001 | ✅一致 | logger.ts:18 | |
| C-002 | ✅一致 | logger.ts:29-40（恰好 5 个方法） | |
| C-003 | ✅一致 | logger.ts:31 | |
| C-004 | ✅一致 | logger.ts:33 | |
| C-005 | ✅一致 | logger.ts:35、260（默认 80） | |
| C-006 | ✅一致 | logger.ts:37、277-279（其余 4 个方法均同步） | |
| C-007 | ✅一致 | logger.ts:39、281（同步签名，内部 `void flushPending()`:301） | |
| C-008 | ✅一致 | logger.ts:54-80（导出、无实例状态；`userHome()` 包 try/catch:56-62） | |
| C-009 | ✅一致 | logger.ts:135（多一个可选 `rootDir`，向后兼容） | |
| C-010 | ✅一致 | logger.ts:21-26（`interface LogEntry` 未 export） | |
| C-011 | ✅一致 | logger.ts:42 | |
| C-012 | ✅一致 | logger.ts:43 | |
| C-013 | ✅一致 | logger.ts:44 | |
| C-014 | ✅一致 | logger.ts:45 | |
| C-015 | ✅一致 | logger.ts:46 | |
| C-016 | ✅一致 | logger.ts:47 | |
| C-017 | ✅一致 | logger.ts:219-222（`timer.unref?.()`） | |
| C-018 | ✅一致 | logger.ts:191（`Math.floor(PERSISTENT_MAX_BYTES / 2)`） | |
| C-019 | ✅一致 | logger.ts:63 | |
| C-020 | ✅一致 | logger.ts:64；test「掩码 password/token 键值并剥控制字符」 | |
| C-021 | ✅一致 | logger.ts:65；test「掩码 sk- / gh* / npm_ / bearer / jwt」 | |
| C-022 | ✅一致 | logger.ts:66；同上 | |
| C-023 | ✅一致 | logger.ts:67；同上 | |
| C-024 | ✅一致 | logger.ts:68（`gi`）；同上 | |
| C-025 | ✅一致 | logger.ts:69（`$1$2***`） | |
| C-026 | ✅一致 | logger.ts:70；test「掩码 sk-…」（JWT 一段） | |
| C-027 | ✅一致 | logger.ts:74（`(?<![\d])…(?![\d])`）；test「掩码手机号与身份证」 | |
| C-028 | ✅一致 | logger.ts:73（前后非数字断言齐全）；test「身份证规则必须排在手机号之前」 | |
| C-029 | ✅一致 | logger.ts:75-78（`k: v` / `k=v` / `k: "v"` 全覆盖） | |
| C-030 | ✅一致 | logger.ts:55-79（串行赋值，无提前 return；规则 9/10 相对 c.md 编号已互换，因两条都带非数字断言，输出等价） | |
| C-031 | ✅一致 | logger.ts:228（先 `sanitize` 再 `.slice(0, DETAIL_MAX)`）；无测试 | |
| C-032 | ✅一致 | logger.ts:49、172-184（正则不匹配即 `continue`） | |
| C-033 | ✅一致 | logger.ts:227-237（顺序与要求逐句对应） | |
| C-034 | ✅一致 | logger.ts:199（四守卫同序短路） | |
| C-035 | ⚠️有差异 | logger.ts:281-302 | 顺序是"清定时器(284-287) → **同步** `appendFileSync` 剩批(288-300) → `void flushPending()`(301)"，全程**不置** `persistenceEnabled = false`。同步落盘是 01 §1 note3 的真机校准（可接受），但"停用持久化"这一步缺失 → dispose 后 `logEvent` 仍入队，满 50 条还会再写盘（logger.ts:232-236），与 c.md:258-259 的三步顺序不符。见 G3。 |
| C-036 | ✅一致 | logger.ts:149-166 | |
| C-037 | ✅一致 | logger.ts:83-89（`(getDay()+6)%7` + `setDate`） | |
| C-038 | ✅一致 | logger.ts:116-118 + home.ts:38-51（`$DSH_HOME` → `~/.dsh`） | |
| C-039 | ✅一致 | logger.ts:156（`log-${weekKey}.ndjson`）；test「写内存 + 落盘，文件名用本周一」 | |
| C-040 | ✅一致 | logger.ts:229、235（一条事件一行 JSON） | |
| C-041 | ✅一致 | logger.ts:170-181（`at >= cutoff` 保留，否则 `unlinkSync`） | |
| C-042 | ✅有意差异 | logger.ts:121-128、136（含分隔符/`.`/`..` 直接抛）；test「目录名必须单段…」 | 01 §1 日志落点契约 note1 明示有意加强；c.md:764 只写"pluginName 必须是安全目录名"（调用方义务），**没有**"模块不做校验"。 |
| C-043 | ✅一致 | logger.ts:240 | |
| C-044 | ⚠️有差异 | logger.ts:106、109 | 实际输出 `timestamps: UTC - this machine is UTC+08:00 (Asia/Shanghai), so add +08h for local time`：分隔符是 ASCII `-`（c.md:237 为 em dash `—`）、小时数带符号位（`+08h` vs `add 8h`）。见 G4。 |
| C-045 | ✅一致 | logger.ts:243 | |
| C-046 | ✅一致 | logger.ts:245 | |
| C-047 | ✅一致 | logger.ts:251 | |
| C-048 | ✅一致 | logger.ts:255 | |
| C-049 | ⚠️有差异 | logger.ts:253 | 实际为 `(none - the buffer starts empty on every start)`（ASCII 连字符），c.md:247 与 01 §1.6 均为 em dash `—`；且 test「exportLogs 段落标题与空缓冲占位串逐字」把 ASCII 版锁成期望值。见 G4。 |
| C-050 | ✅一致 | logger.ts:241、244、246-249（header / snapshot / priorSessions 逐条 sanitize） | |
| C-051 | ✅一致 | logger.ts:231；test「超过 200 条丢最旧」 | |
| C-052 | ✅一致 | logger.ts:236（`void flushPending()`，不 await） | |
| C-053 | ✅一致 | logger.ts:207-210（`unshift` 回队首 + 熔断） | |
| C-054 | ✅一致 | logger.ts:151-165（整函数 try/catch → `persistenceEnabled = false`） | |
| C-055 | ✅一致 | logger.ts:199（`currentFile === ''` 短路） | |
| C-056 | ✅一致 | logger.ts:200、212（`flushing` 互斥 + finally 释放） | |
| C-057 | ✅一致 | logger.ts:273（pending 追加到读盘结果尾部）；test「readPersistentLog 合并尚未 flush 的待写行」 | |
| C-058 | ✅一致 | logger.ts:265（`readFileSync`，低频诊断路径） | |
| C-059 | ✅一致 | logger.ts:229（`toISOString()`） | |
| C-060 | ✅一致 | logger.ts:100（偏移取 `getTimezoneOffset`，与 Intl 输出等价）、105（IANA 名走 `Intl.DateTimeFormat`）、110-112（try/catch） | |
| C-061 | ✅一致 | logger.ts:64（控制字符先剥离）+ 235（`JSON.stringify` 单行） | |
| C-062 | ✅一致 | logger.ts:288-301（同步落盘反而缓解了该限制，注释 288-289 记录了代价） | |
| C-063 | ✅一致 | 全文件无"持久化已停用"的对外通道（与限制描述一致） | |
| C-064 | ✅一致 | logger.ts:141-147（每实例独立 `pendingLines`/`persistentBytes`/timer） | |
| C-065 | ✅一致 | logger.ts:260-275（不判格式版本） | |
| C-066 | ✅一致 | logger.ts:219-222、236 | |
| C-067 | ✅一致 | logger.ts:216-224（建即 `refreshWeek()`，仍 enabled 才挂 `unref` 定时器） | |
| C-068 | ✅一致 | crypto.ts:18-28（恰 3 个可选字段） | |
| C-069 | ✅一致 | crypto.ts:31-35（恰 3 个同步方法） | |
| C-070 | ✅一致 | crypto.ts:74（`async` / `Promise<FieldCryptoHandle>`） | |
| C-071 | ✅一致 | crypto.ts:46-48（`dshHomePath('storages','codeagent','master.key')`） | |
| C-072 | ✅一致 | crypto.ts:76 | |
| C-073 | ✅一致 | crypto.ts:77（默认 `false`） | |
| C-074 | ✅一致 | crypto.ts:122；test「AES 往返（空串原样）」 | |
| C-075 | ✅一致 | crypto.ts:139；同上 | |
| C-076 | ✅一致 | crypto.ts:118（`iv:tag:cipher`）、125（base64） | |
| C-077 | ✅一致 | crypto.ts:37-39、114-117 | |
| C-078 | ✅一致 | crypto.ts:37、97 | |
| C-079 | ✅一致 | crypto.ts:99（`{ mode: 0o600, flag: 'wx' }`）；test「master.key 是被解密的密钥且只创建一次（0600）」 | |
| C-080 | ✅一致 | crypto.ts:56-63（两级 `createRequire`） | |
| C-081 | ✅一致 | crypto.ts:62（`profiles/web/node_modules/@primno/dpapi/package.json` 作锚点） | |
| C-082 | ✅一致 | crypto.ts:59-66（两级失败返回 `null`） | |
| C-083 | ✅一致 | crypto.ts:13、56（`createRequire`，无静态 import） | |
| C-084 | ✅一致 | crypto.ts:93-109（tryRead → mkdir → randomBytes(32) → write wx） | |
| C-085 | ✅一致 | crypto.ts:84-87（`< 32` 返回 null；`subarray(0,32)` 并写 `cachedKey`） | |
| C-086 | ✅一致 | crypto.ts:81-91（纯读）；test「解密路径不会创建 key」 | |
| C-087 | ✅一致 | crypto.ts:102-109（catch → 重读赢家）；test「并发首建最终只有一把可用的 key」 | |
| C-088 | ✅一致 | crypto.ts:79、82、100 | |
| C-089 | ✅一致 | crypto.ts:121-136（空串→DPAPI(CurrentUser)→base64，DPAPI 抛错继续 AES） | |
| C-090 | ✅一致 | crypto.ts:132-133（`strictEncrypt` 为真则 `throw`） | |
| C-091 | ✅一致 | crypto.ts:134（默认路径返回明文）；无测试（两态未断言） | |
| C-092 | ✅一致 | crypto.ts:138-163（DPAPI 试→段数判断，按格式自识别） | |
| C-093 | ✅一致 | crypto.ts:147-148（无 key 返回原密文，不建 key） | |
| C-094 | ✅一致 | crypto.ts:149-150 | |
| C-095 | ✅一致 | crypto.ts:153-163（`final()` 失败被 catch → 原密文）；test「解不开时原样返回（调用方用 === 判定）」 | |
| C-096 | ⚠️有差异 | crypto.ts:31-35（接口零 JSDoc）；契约只在 crypto.ts:161-162 与模块头 4-5 | c.md:328-329 要求把 `decrypted === ciphertext` 的判据写进 `FieldCryptoHandle` 的 JSDoc；实现只写在 `decryptField` 内部注释里。语义已实现，缺陷在"契约可见性"。见 G5。 |
| C-097 | ✅一致 | crypto.ts:115（`createCipheriv` 未传 AAD） | |
| C-098 | ✅一致 | crypto.ts:114（每次 `randomBytes(12)`） | |
| C-099 | ✅一致 | crypto.ts:99（mode 只在写时生效，已存在文件不 stat/不可 chmod） | |
| C-100 | ✅一致 | 无备份/迁移机制（与限制描述一致） | |
| C-101 | ✅一致 | crypto.ts:124-129、140-146（两条路都试） | |
| C-102 | ✅一致 | crypto.ts:138-163（只读，无 mkdir/写）；test「解密路径不会创建 key」 | |
| C-103 | ✅一致 | crypto.ts:41-44（内部最小形状 `interface DpapiModule`，未 export） | |
| C-104 | ✅一致 | router.ts:29-38 | |
| C-105 | ✅一致 | router.ts:35（首句 `headersSent` 守卫）；test「已发头后 sendResponse 静默返回」 | |
| C-106 | ✅一致 | router.ts:41-46 | |
| C-107 | ✅一致 | router.ts:49-56 | |
| C-108 | ✅一致 | router.ts:59-61（405 + `allow`，body `''`） | |
| C-109 | ✅一致 | router.ts:43、55 | |
| C-110 | ✅一致 | router.ts:64 | |
| C-111 | ✅一致 | router.ts:67 | |
| C-112 | ✅一致 | router.ts:69（比 `.host` 含端口）；test「isTrustedInbound 四档」（localhost:3080 一组） | |
| C-113 | ✅一致 | router.ts:68-72（`new URL` 包 try/catch；`Origin: null` 抛错 → false） | |
| C-114 | ✅一致 | router.ts:76（默认 8192） | |
| C-115 | ✅一致 | router.ts:79-84（边读边累加，超限即抛） | |
| C-116 | ✅一致 | router.ts:80（`Buffer.isBuffer` 分支 + `Buffer.from`） | |
| C-117 | ✅一致 | router.ts:82（抛错，不返回结果对象） | |
| C-118 | ✅一致 | router.ts:98 | |
| C-119 | ✅一致 | router.ts:99-110（手写 `indexOf('?')` + split，无 `new URL`） | |
| C-120 | ⚠️有差异 | router.ts:89-95（`safeDecode` 解码失败返回原文）、106-107 | 解码失败**不跳过**该 pair：`?a=%E0%A4&a=2` 返回 `'%E0%A4'` 而不是 `'2'`；畸形键同理（用原文比较键）。test「queryOf 处理空值、重复键与畸形编码」只覆盖了异键畸形（`bad=…&ok=1`）。见 G2。 |
| C-121 | ✅一致 | router.ts:107（无等号返回 `''`）；test 同上 | |
| C-122 | ✅一致 | router.ts:113-116（无 `response`） | |
| C-123 | ✅一致 | router.ts:119、128-130 | |
| C-124 | ✅一致 | router.ts:122-126（恰 3 字段，无 trust） | |
| C-125 | ✅一致 | router.ts:137-139 | |
| C-126 | ✅一致 | router.ts:174（7 个方法） | |
| C-127 | ✅一致 | router.ts:177 | |
| C-128 | ✅一致 | router.ts:16-26（`name = 'HttpRouteError'` 在 22） | |
| C-129 | ✅一致 | router.ts:180（可单独导出复用）；test「isTrustedInbound 四档」 | |
| C-130 | ✅一致 | router.ts:188-194（恰 5 成员） | |
| C-131 | ✅一致 | router.ts:197-201（恰 3 成员） | |
| C-132 | ✅有意差异 | router.ts:204-214（9 字段，多 `trustedHosts`:211） | c.md:986 明示"加 Host 围栏需要新的 `trustedHosts` 选项，属于 API 变更"，01 §3.6/§7#1 也已落地该选项；C-132 的"恰 8 字段"是 0.1.6 快照。默认空数组 = 保持旧行为（router.ts:356），不破坏兼容。 |
| C-133 | ✅一致 | router.ts:325-327 | |
| C-134 | ✅一致 | router.ts:216-218、220-224、226、235、266、278、286 均未 export；`decodePathSegment`→`safeDecode`(89)、`allowOf`→内联(337-344) | |
| C-135 | ✅一致 | router.ts:76、329（均 8192） | |
| C-136 | ✅一致 | router.ts:328-330、337-344 | |
| C-137 | ✅一致 | router.ts:216-218（`METHOD_ORDER` 决定 Allow 顺序，`BODY_METHODS` = POST/PUT/PATCH，`PARAM_PREFIX` 只有 `:`） | |
| C-138 | ✅一致 | router.ts:243；test「content-type 非 JSON → 415」 | |
| C-139 | ✅一致 | router.ts:261；test「非对象 JSON → 400 body is not a JSON object」 | |
| C-140 | ✅一致 | router.ts:362 | |
| C-141 | ✅一致 | router.ts:257 | |
| C-142 | ✅一致 | router.ts:82 | |
| C-143 | ✅一致 | router.ts:148 | |
| C-144 | ✅一致 | router.ts:148（`forbidden`）、156（`bad request`）、168（`internal`） | |
| C-145 | ✅一致 | router.ts:226-233；test「HttpRouteError 用自带 status/code，其它错误 500 internal」 | |
| C-146 | ✅一致 | router.ts:243 | |
| C-147 | ✅一致 | router.ts:246-252（有声明才判）；test「声明长度超限 → 413」 | |
| C-148 | ✅一致 | router.ts:254-258 | |
| C-149 | ✅一致 | router.ts:260-262 | |
| C-150 | ✅一致 | router.ts:358、362 | |
| C-151 | ✅一致 | 六处闸门抛的全是 `HttpRouteError`（243、250、257、261、358、362） | |
| C-152 | ✅一致 | router.ts:167-169 | |
| C-153 | ✅一致 | router.ts:143-146 → 147-150 → 151-159 → 160-169 | |
| C-154 | ✅一致 | router.ts:346-392（方法门 349 → 围栏 361 → 读体 366 → 匹配 370 → 业务 381 → catch 388） | |
| C-155 | ✅一致 | router.ts:240-245 → 246-252 → 253-258 → 259-263 | |
| C-156 | ✅一致 | router.ts:140（归一一次）、143 | |
| C-157 | ✅一致 | router.ts:141（`needsBody`）、151-159（GET/HEAD 时 `body` 为 `undefined`） | |
| C-158 | ✅一致 | router.ts:349-353（表级）；test「方法门：表里没有的方法 → 405 + allow」 | |
| C-159 | ✅一致 | 顺序即 router.ts:349-390 的书面顺序；test「未命中的 POST 仍然先过围栏（跨站 → 403 而不是 404）」 | |
| C-160 | ✅一致 | router.ts:162-166（`isStatusEnvelope` 128-130） | |
| C-161 | ✅一致 | router.ts:278-284（`pathname === normalized` / `startsWith(normalized + '/')`）；test「前缀碰撞不匹配（/apix 不算 /api 下）」 | |
| C-162 | ✅一致 | router.ts:286-319（先段数 293，再逐段 296-315） | |
| C-163 | ✅一致 | router.ts:303-307（空段不命中） | |
| C-164 | ✅一致 | router.ts:308 + 89-95（失败保留原文） | |
| C-165 | ✅一致 | router.ts:332-336（装配期 `splitRoutePath`） | |
| C-166 | ✅一致 | router.ts:370（`request.url ?? ''`） | |
| C-167 | ✅一致 | router.ts:388-391（`for await` 抛错冒泡到 `onError`） | |
| C-168 | ✅一致 | router.ts:227（默认 onError 首句）+ router.ts:35（`sendJson` 链） | |
| C-169 | ✅一致 | router.ts:354-360（默认不做 Host 围栏，仅显式传 `trustedHosts` 才校验） | |
| C-170 | ✅一致 | router.ts:303（只认 `:` 前缀，无通配） | |
| C-171 | ✅一致 | router.ts:122-126（`jsonRoute` 无 trust 选项，恒 `sameOrigin`） | |
| C-172 | ✅一致 | router.ts:278-284（`prefix` 与注册 path 必须逐字一致） | |
| C-173 | ✅一致 | router.ts:257（合并消息） | |
| C-174 | ✅一致 | router.ts:246-252 与 253-258 分离（不靠字符串匹配区分 413/400） | |
| C-175 | ✅一致 | net.ts:20-26（恰 5 个可选字段） | |
| C-176 | ✅一致 | net.ts:29-34、82-83（30000 / true） | |
| C-177 | ✅一致 | net.ts:37-44（恰 6 个成员） | |
| C-178 | ✅一致 | net.ts:81（同步工厂） | |
| C-179 | ✅一致 | net.ts:154-157（泛型，不绑 `ProxyFetchHandle`） | |
| C-180 | ✅一致 | net.ts:82、109（`init.timeoutMs` 覆盖） | |
| C-181 | ✅一致 | net.ts:83（`!(options.insecure ?? true)`） | |
| C-182 | ✅一致 | net.ts:158（`Math.max(1, Math.floor(...))`） | |
| C-183 | ✅一致 | net.ts:48-61 定义、net.ts:84 在工厂内首次调用（模块求值期不碰 undici） | |
| C-184 | ✅一致 | net.ts:15（`import type`）、17（`typeof import('undici')`） | |
| C-185 | ✅一致 | net.ts:85-86（TLS 只落在两个 Agent 上，无 `process.env` 赋值） | |
| C-186 | ✅一致 | net.ts:37-44 两个成员 + 95-103（dispatcher 只取 undici Agent） | |
| C-187 | ✅一致 | net.ts:108-112（timeout 与 `init.signal` 用 `AbortSignal.any` 合并） | |
| C-188 | ✅一致 | net.ts:72-74（`http_proxy ?? HTTP_PROXY ?? npm_config_proxy`；https 同构且 `?? http`） | |
| C-189 | ✅一致 | net.ts:72-73（小写在前） | |
| C-190 | ✅一致 | net.ts:73（`?? https` 回退到 http 代理，再经 91-93 暴露给 `configuredProxy()`） | |
| C-191 | ✅一致 | net.ts:63-67（空串/纯空白 → null） | |
| C-192 | ✅一致 | net.ts:72-73（`npm_config_*` 作第三来源） | |
| C-193 | ✅一致 | net.ts:63-68（trim + 无 scheme 补 `http://`） | |
| C-194 | ✅一致 | net.ts:98（`proxyAgent ??=` 懒建复用） | |
| C-195 | ✅一致 | net.ts:91-93、107（每次 fetch 调 `proxyFromEnv()`） | |
| C-196 | ✅一致 | net.ts:95-103（无代理 → `insecureAgent`；有代理 → `proxyAgent`） | |
| C-197 | ✅一致 | net.ts:128（`useTimeout = false`，init 原样透传 113-117） | |
| C-198 | ⚠️有差异 | net.ts:128、107、95-103 | `insecureFetch` 与 `fetch` 共用 `fetchImpl`，而 `fetchImpl` **无条件** `dispatcherFor()`；配了 `https_proxy` 时 `insecureFetch` 也会走 `EnvHttpProxyAgent`，"始终直连、绝不走代理"的语义丢失。见 G1。 |
| C-199 | ✅一致 | net.ts:132-133 | |
| C-200 | ✅一致 | net.ts:135-136（`await …close()`，含 proxyAgent）、141（`destroy()`）；两段 try/catch 134-139 / 140-144 | |
| C-201 | ✅一致 | net.ts:134-144（全 try/catch，无 reject 路径） | |
| C-202 | ✅一致 | net.ts:177-184（`acquire`/`release`，`release` 在 `finally`） | |
| C-203 | ✅一致 | net.ts:48-61（惰性 `createRequire`，两级缓存 `cachedUndici`） | |
| C-204 | ✅一致 | net.ts:63-68（只补 scheme 不校验，构造期才抛）——与限制描述一致 | |
| C-205 | ✅有意差异 | net.ts:106（`if (disposed) throw new Error('proxy-fetch: handle already disposed')`） | c.md:952 **自己矛盾**："表现"列说只挡重复 dispose、不挡 fetch，"剩余风险"列却引用测试名"dispose: 关闭后 fetch 不再可用"；01 §7#4 明示本次改成抛错（行为变更）。属有意，但必须发版本公告。 |
| C-206 | ✅一致 | net.ts:154-185 提供 `createLimitedFetch` 但不强制（与限制一致） | |
| C-207 | ✅一致 | net.ts:98-101（`EnvHttpProxyAgent` 自带 `NO_PROXY`） | |
| C-208 | ✅一致 | net.ts:118（`undiciModule.fetch` + `dispatcher`） | |

## GAPS

> 6 个 ⚠️ 条目合并为 5 条（C-044 与 C-049 同源）。排序 = 影响面 × 用户可感知度。

### G1 · C-198 `insecureFetch` 在代理环境里被送进代理（语义丢失）

- **现状**：`net.ts:128` 的 `insecureFetch` 只是 `fetchImpl(url, init, false)`；`fetchImpl:107` 无条件 `const dispatcher = dispatcherFor()`，而 `dispatcherFor:95-103` 在 `https_proxy`/`HTTPS_PROXY`/`npm_config_https_proxy` 任一存在时返回 `EnvHttpProxyAgent`。因此"始终直连"的入口在代理机器上反而走代理：内网端点会被代理拒/被代理记录，而**同一份代码在无代理机器上又是直连**，问题只在客户现场暴露。
- **原始要求**：C-198「`insecureFetch` 同时承担"始终直连、绝不走代理"的端点语义」（c.md:540）。对照 C-196 对 `fetch` 的要求是对的，缺陷只在这一条路径。
- **最小修法**：`src/core/net.ts:95` 改 `dispatcherFor(direct = false)`，`direct === true` 时直接 `return insecureAgent`；`net.ts:128` 传 `true`（`fetchImpl` 多一个 `direct` 参数或给 `insecureFetch` 单独短的实现）。同步在 `docs/design/01-core-utils.zh.md §4.6` 补一句"`insecureFetch` 恒直连，不受 `*_proxy` 影响"。
- **要补的测试断言**（新建 `tests/core/net.test.ts`，stub 掉 `undici.fetch` 捕获 `init.dispatcher`）：设 `process.env.https_proxy='http://127.0.0.1:9'` 后 —— ① `handle.configuredProxy()` 返回该串；② `handle.fetch(...)` 的 `init.dispatcher !== handle.insecureAgent`；③ `handle.insecureFetch(...)` 的 `init.dispatcher === handle.insecureAgent`。跑完恢复 env。

### G2 · C-120 `queryOf` 不跳过畸形 pair（前端参数静默取错值）

- **现状**：`router.ts:89-95` 的 `safeDecode` 解码失败时**返回原文**；`queryOf:102-108` 拿到原文既不跳过也不报错。于是 `?a=%E0%A4&a=2` 返回 `'%E0%A4'`（而不是后一个合法值 `'2'`），`?%E0=1&a=2&…` 这类畸形键会按原文参与比较。现有 test「queryOf 处理空值、重复键与畸形编码」用的是**不同键**（`bad=…&ok=1`），没盖住同键场景。
- **原始要求**：C-120「`queryOf` 中解码失败（`%zz`、不完整 `%E0%A4`）的 pair 必须**跳过继续找**；同键多值且前一个畸形时必须取到后面那个合法值」（c.md:390-391）。
- **最小修法**：`src/core/router.ts:89` 另加 `function tryDecode(text: string): string | undefined`（失败返回 `undefined`），`queryOf` 改用它：键解码失败 → `continue`，值解码失败 → `continue`；`safeDecode` 保留原语义继续服务 `matchRoute:308`（路径段"解码失败保留原文"是 C-164 的要求，不能一起改）。
- **要补的测试断言**：`queryOf(req('/x?a=%E0%A4&a=2'),'a') === '2'`（现返回 `'%E0%A4'`）；`queryOf(req('/x?a=%zz'),'a') === null`（现返回 `'%zz'`）；保留现有 `?flag → ''`、`a=1&a=2 → '1'`、`bad=…&ok=1 → '1'` 三条（这三条现状已通过，不得回归）。注意：畸形**键** + 后续合法 `a=2` 的场景现状已能返回 `'2'`（因为键比对失败会 `continue`），真正失效的只有"键命中但值畸形"。

### G3 · C-035 `dispose()` 少一步"停用持久化"，dispose 之后仍可能写盘

- **现状**：`logger.ts:281-302` 的顺序是"清定时器(284-287) → **同步** `appendFileSync` 写完剩批(288-300) → `void flushPending()`(301)"，全程**没有** `persistenceEnabled = false`。同步落盘本身是 01 §1 note3 的真机校准（比 `void flushPending()` 更可靠，可留）；但"停用"缺失导致：dispose 后 `logEvent` 仍 `pendingLines.push`（232-236 的守卫只看 `persistenceEnabled`），累计到 50 条会再次 `void flushPending()` —— 与 01 §1.9 第 10 条"dispose 后只写内存"的自我描述也不一致。
- **原始要求**：C-035「`dispose()` 三步顺序固定：清定时器 → `void flushPending()` → `persistenceEnabled = false`；**先 flush 再停用**，否则最后一批会被守卫①挡住」（c.md:258-259、c.md:264-276）。
- **最小修法**：`src/core/logger.ts:301` 之后补 `persistenceEnabled = false`。若产品上确实要"dispose 后继续接受事件并异步写盘"，则反过来改 `01-core-utils.zh.md §1.7` 的表并把它列进 §7 行为变更清单——二者必须选一个，不能像现在这样代码与两份文档三方不一致。
- **要补的测试断言**：① `logger.logEvent×3` 后 `dispose()`，随后直接 `readFileSync` 本周文件断言 3 行（同步落盘生效）；② `dispose()` 后再 `logEvent` 60 条，文件行数**不再增长**（现会增长）；这 60 条仍能经 `exportLogs()` 导出（环形缓冲照旧），但**不应**出现在 `readPersistentLog()`（未入 pending 队列）；③ `dispose()` 调两次不重复写（已由 test「dispose 幂等…」部分覆盖，需补文件行数断言）。

### G4 · C-044 / C-049 `exportLogs` 两处固定文案与素材不一致，且测试把错值锁死

- **现状**：`logger.ts:106` 产出 `timestamps: UTC - this machine is UTC+08:00 …`（ASCII 连字符），`logger.ts:109` 产出 `so add +08h for local time`（带符号位）；`logger.ts:253` 产出 `(none - the buffer starts empty on every start)`（ASCII 连字符）。test「exportLogs 段落标题与空缓冲占位串逐字」的期望值写的是 ASCII 版，等于用测试保住了与素材不同的文案。这份文本是**用户拿去提 issue 的成品**，前端/客服若按 `—` 或 `add 8h` 匹配会全部失配。
- **原始要求**：C-044「时区提示行必须逐字为：`timestamps: UTC — this machine is UTC+08:00 (Asia/Shanghai), so add 8h for local time`」（c.md:237）；C-049「缓冲为空时必须输出 `(none — the buffer starts empty on every start)`（含 em dash）」（c.md:247，01 §1.6 复述同一条）。
- **最小修法**：`logger.ts:106` 与 `logger.ts:253` 把 `" - "` / `"(none - "` 改成 em dash `—`；`logger.ts:109` 改成 `${offsetMinutes < 0 ? '-' : ''}${Number(hh)}h`（正偏移不带 `+`、负偏移保留 `-`）。同步改 `tests/core/logger.test.ts` 那条期望串，否则测试会红。
- **要补的测试断言**：① 空缓冲报告必须包含字面 `(none — the buffer starts empty on every start)`，且 `!report.includes('(none - ')`；② 时区行匹配 `/^timestamps: UTC — this machine is UTC[+-]\d{2}:\d{2}( \([A-Za-z0-9_+\/-]+\))?, so add -?\d{1,2}h for local time$/m`；③ 断言时区行**不出现** `add +`。

### G5 · C-096 `decrypted === ciphertext` 契约没写进 `FieldCryptoHandle` 的 JSDoc

- **现状**：`crypto.ts:31-35` 的 `FieldCryptoHandle` 三个方法零注释；判据只出现在 `decryptField` 内部注释（`crypto.ts:161-162`）与模块头（`crypto.ts:4-5`）。调用方看类型声明（`lib/types/**`）时看不到"返回原样 = 没解开"，很容易把密文当明文存回去。
- **原始要求**：C-096「契约必须是：`decrypted === ciphertext` 表示"这可能是明文或别人的密文"；该约定**必须写在 `FieldCryptoHandle` 的 JSDoc 里**」（c.md:327-329）。
- **最小修法**：`src/core/crypto.ts:31-35` 给接口补 3 行 JSDoc（接口头 + `encryptField` + `decryptField`），措辞直接照抄 c.md:328；行为不改。
- **要补的测试断言**：无需运行时断言（`tests/core/crypto.test.ts`「解不开时原样返回（调用方用 === 判定）」已覆盖行为）。可选：在 `scripts/verify.mjs` 加一条字符串断言"`lib/types/**/crypto.d.ts` 必须出现 `decrypted === ciphertext`"，把文档要求变成可执行检查。

### 附·测试覆盖缺口（不计入上面的状态统计，但同样需要补）

- **`tests/core/net.test.ts` 完全不存在** → C-175…C-208 共 34 条**零测试**。01 §4.9 列了 8 条测试契约（undici 惰性、缺 undici 才抛、代理优先级 6 组、`rejectUnauthorized` 反向、`AbortSignal.any`、并发上限、dispose 幂等、`insecureFetch` 无超时），一条都没落地。这是本层最大的"证据缺口"：G1 这种缺陷就是因为没测试才活到今天。
- **logger 缺 4 条 01 §1.9 契约**：50 条阈值立即 flush、5 s 定时器 `hasRef() === false`、`appendFile` 抛错后熔断且不再重试、跨周（周一 00:00）边界；另缺 `detail` 超 600 截断、`dispose` 后不再写盘的断言（见 G3）。
- **router 缺 3 条 01 §3.7 契约**：`requireJsonContentType: false` 放行、chunked 超限的合并消息（400 而非 413）、`onNotFound` 与 `strict` 档 8 组组合（现只测了 4 组）。
- **crypto 缺 2 条 01 §2.8 契约**：`strictEncrypt` 两态（默认 `false` 应返回明文，现无断言）、DPAPI 不可用时降级 AES（Windows 上有 dpapi 时走不到 AES 分支，需注入假 `DpapiModule`）。

## 疑似素材错误

> 逐条回查 `docs/raw/c.md` 原文后的结论；这些**不采纳为缺陷**，其中两条已在实现里留下"过时理由"的注释/测试。

1. **C-044 要求"逐字含 `UTC+08:00 (Asia/Shanghai)`"** —— 不采纳这部分。c.md:237 是作者机器上的**示例输出**；c.md:250-253 明确 `timezoneNote()` 用 `Intl.DateTimeFormat` **动态**取偏移与 IANA 时区名。所以可断言的是"结构 + 分隔符 + `add <n>h` 写法"，不是具体时区。该条只采纳分隔符/小时写法（见 G4），不把 `Asia/Shanghai` 当断言。
2. **C-134 把 11 个内部符号名当硬要求** —— c.md:819-822 是 0.1.6 源码的"未导出（内部）"**描述性清单**，不是 API 契约；要求 `decodePathSegment` / `allowOf` 必须同名存在等于禁止重构。实现用 `safeDecode`（router.ts:89）+ 内联 `allow`（337-344），"不导出闸门助手"的意图满足 → 判一致。
3. **C-205 与 c.md:952 同行自相矛盾** —— "表现"列写 `disposed` 只挡重复 dispose、不挡 fetch；同一行"剩余风险"列却引用了一个测试名 `dispose: 关闭后 fetch 不再可用`。素材无法确定 0.1.6 的真实行为，因此不判缺陷，按 01 §7#4（有意改成抛错）记"有意差异"；但它是破坏性变更：卸载时按 `ctx.effect(() => () => { void handle.dispose() })` 的写法，之后仍在飞的 `handle.fetch(...)` 会 reject，**必须发版本公告**。
4. **G2 存疑#8（"规则 9 会先截断身份证，尾号泄漏"）不成立** —— c.md:184-185 两条规则**都**带前后非数字断言。以 `130101199003071234` 为例：手机号的候选起点 0 被后行断言 `(?![\d])`（第 12 位是 `3`）挡住，候选起点 6 被先行断言 `(?<![\d])`（前一位是 `1`）挡住，规则 9 根本不会命中，规则 10 随后整段抹掉。即规则 9/10 实际**可交换**。当前实现把身份证提到前面（logger.ts:71-74）并配了 test「身份证规则必须排在手机号之前」，其注释理由（"否则前 11 位被当手机号"）在带断言的正则下不成立（断言本身仍然通过）。建议把该注释/测试名改成"防御深数字串"，不要保留错误论证。
5. **导出计数（G2 存疑#1/#2）已可定案** —— 对照 c.md:751（`http-route` 10 函数 + 8 类型 + 1 class = 19）与 c.md:824（`proxy-fetch` 5 个导出）以及 `src/index.ts:18-51` 的实际导出：router 10 函数 + 1 class + 8 类型、proxy 2 函数 + 3 类型，**与 §7.5 一致**；c.md:20 的"11 个函数"、c.md:21 的"类型 4 个"是 §0 速览笔误 → 不采纳笔误，清单取的口径正确。
6. **C-126/C-137 的 `BODY_METHODS` 内容无据可查** —— c.md:810、c.md:983 只要求"新增方法要同时同步 `METHOD_ORDER` / `BODY_METHODS`"，**从未给出集合内容**。清单据此断言"`BODY_METHODS` 决定哪些方法读体"但无法判定 0.1.6 是否含 `DELETE`。实现取 `POST/PUT/PATCH`（router.ts:217），意味着 `DELETE` 请求不读体、handler 收到 `{}`（与 `jsonRoute` 的"非 GET/HEAD 都读体"不一致，但这是 0.1.6 就有的两套语义）。→ 记为"素材缺内容"，不判违规；建议在 `01-core-utils.zh.md §3.2` 补一行集合定义，免得下一个人再猜。
7. **C-042 "模块不做校验"是对 c.md:764 的过度解读** —— 原文只说"`pluginName` 直接拼进路径，**必须是安全目录名**"（给调用方的义务），没有"模块不得校验"。实现主动抛错（logger.ts:121-128）与 c.md 不冲突，且有真机事故背书（`logs/dsh-magica-spellbook/questions/`）→ 判"有意差异"，不进 GAPS。
8. **C-060 "偏移必须从 `Intl.DateTimeFormat` 取"** —— c.md:252 强调的其实只是"对 `Intl.DateTimeFormat` 包了 `try/catch`（精简 ICU 构建会抛）"。实现取偏移用 `getTimezoneOffset()`（logger.ts:100，小时:分钟输出与 Intl 等价）、IANA 名走 Intl（105）、try/catch 在 110-112 → 判一致，不按"取法"判违规。

## 修复记录（Round 2）

| 项 | 改动 | 回归 |
|---|---|---|
| C-120 | queryOf 畸形 pair 跳过、取下一个可解码值；路径参数解码失败按不匹配 | 	ests/core/router.test.ts（2 例） |
| C-035 | dispose() 收尾后置 persistenceEnabled = false（不再写盘） | 	ests/core/logger.test.ts（dispose 后不写盘） |
| C-198 | insecureFetch 恒用 insecureAgent（配了代理也直连） | 	ests/core/net.test.ts + 实现注释 |
| 测试缺口 | 新增 	ests/core/net.test.ts（8 例：句柄形状/代理读取/dispose 幂等与拒绝/并发上限/失败不泄漏槽位） | — |
| 有意差异 | pluginName 必须单段（拒绝 pkg/questions）、	rustedHosts 默认回环、dispose 后 fetch 抛错 | 已在  0-overview §3.8 记录 |
