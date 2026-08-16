# 完整改造方案

服务端持久化运行 + Webhook 触发器 + Python 代码节点。

本文件是**唯一的执行依据**。[server-runtime-design.md](./server-runtime-design.md) 保留为存储与
Webhook 的深层设计参考，但凡与本文件冲突处**以本文件为准**（第 2 节列出了被推翻的部分）。

---

## 0. 这份方案怎么来的

对市面上主流工作流引擎做了一轮系统性机制调研：8 个系统族并行深挖，4 个映射 agent
逐条对照本仓库代码给判断，1 个评审 agent 找遗漏、挑错判断。

- 挖出 **160 条具体机制**（n8n 21 / Dify 16 / Step Functions 15 / Temporal 13 /
  Airflow 11 / Argo 8 / Conductor 7 / BPMN 6 / 其余 63）
- 其中 **151 条**给出了采纳判断：`adopt` 21 · `adapt` 102 · `defer` 13 · `skip` 15
- 评审推翻了 **9 条判断**，补出 **10 条整条清单都漏掉的机制**

判断的原则是硬的：**不因为机制来自知名系统就采纳**。本项目是内部工具、个位数并发、
单机部署、数据管道场景，很多为大规模多租户设计的机制在这里是纯负担 —— 第 5 节明确列出。

---

## 1. 先修：四个已上线的缺陷 ✅ 已完成

这四条**不属于任何里程碑**，也不依赖服务端改造。前两条是正确性/安全问题，
放着不管，后面所有改造都建在漏的地基上。

> **已完成（连同三件不依赖前置的快赢）：**
> - ✅ 1.1 引用未命中报错 + `default()` 逃生口
> - ✅ 1.2 SSRF（每跳校验、跨主机剥 Authorization、显式网段而非 `is_private`）
> - ✅ 1.3 `client.ts` 请求超时（分档 30s / 130s）
> - ✅ 1.4 `foreach` 的 `slice(0,3)` → 1000 上限且超限失败
> - ✅ 「定时触发未生效」提示（节点上 + 流程列表）—— M2 落地后翻
>   `SCHEDULER_ENABLED` 一个常量即可
> - ✅ 链式过滤器 + `sum`/`unique`/`join`/`sort`（§2.4 三件小事已全部完成）
> - ✅ 大 output 阈值拍板 256 KB（见 M1）
> - ✅ 附带：`engine.ts` 从不可测变成可测（M1 拆 `engine-core` 的前置）
>
> 新增测试 `test/expression.test.ts` 34 例、`server/test_ssrf.py` 33 例；
> 全量 68（前端）+ 187（Python）通过。

### 1.1 ★ 模板引用未命中会静默渲染成空串

[engine.ts:78](../src/lib/engine.ts:78)

```ts
return value.replace(blockRe(), (_, expr) => {
  const v = resolveExpr(String(expr).trim(), ctx)
  return typeof v === 'string' ? v : JSON.stringify(v) ?? ''   // ← undefined → ''
})
```

`JSON.stringify(undefined)` 返回 `undefined`（值，不是字符串），`?? ''` 把它变成空串。
于是 `今天异常 {{ $.nodes.q1.output.summary.bad }} 条` 里那个不存在的字段渲染成空，
run 记 **success**，企微群里收到一句缺了数字的日报。

引擎对裸标识符、写错的过滤器都专门抛了错（注释里写明了"宁可在这里炸掉"的理由），
**唯独漏了未命中的引用**。而 `sql.query` 的输出结构本来就是 probe/run 学出来的 ——
Hive 列名一变就命中这条路径。编辑期的 `validateNode` 挡不住这种运行时漂移。

> 参考：Airflow Jinja `StrictUndefined` / ASL `States.ParameterPathFailure` /
> Argo parameter-not-found / Camunda 表达式求值失败 → incident。
> **四个系统的一致选择都是报错终止**，需要空值的场合用显式 `default(…)` 开口子。

**改**：`resolveExpr` 求值为 `undefined` 时抛错，报文带路径。加一个 `| default('—')`
过滤器给确实允许缺值的场合。工作量半天。

### 1.2 ★★ `http.request` 节点的 SSRF

[http_request.py](../server/sql_service/http_request.py) 的 `_url()` 只校验了三件事：
scheme 是 http/https、hostname 非空、URL 里不带 userinfo。**没有任何目的地限制。**

而 `requests.request(...)`（:211）没有传 `allow_redirects=False` —— 默认跟随重定向，
且重定向后的地址不再走 `_url()`。所以即使加了目的地校验，一个 302 就能绕过。

这个进程同时持有数据平台机器人票（[robot.py](../server/sql_service/robot.py)）和
企微 webhook 地址（[wecom.py](../server/sql_service/wecom.py)），且服务端目前**没有任何认证**。
任何能打开编辑器的人都能让它去打内网任意地址（含云元数据地址 `169.254.169.254`）
并把响应体读回画布。

**改**（约 20 行）：
- 解析后校验目的 IP：拒绝 loopback、link-local（含 `169.254.0.0/16`）、私网段、保留段
- `allow_redirects=False`，自己按跳数循环，**每一跳重新校验**（防 DNS rebinding 与 302 绕过）
- 出网走目的白名单（配置项，默认只放行明确列出的域名）

> 调研原本把 SSRF 只放在"将来的 Python 代码节点沙箱要不要走正向代理"里讨论，
> 然后因为"代码节点不联网"整条 skip 掉了 —— 正好漏掉当下已经开着的这扇门。
> 这是评审 agent 找回来的。

### 1.3 `client.ts` 的 fetch 没有任何超时

[client.ts](../src/lib/client.ts) 的 `req()` 直接 `fetch(...)`，不带 `AbortSignal.timeout`。
一次 poll 请求挂住就是永久挂住，`MAX_CONSECUTIVE_POLL_FAILURES = 5`
（[engine.ts:559](../src/lib/engine.ts:559)）永远数不到 5。

**改**：`req()` 加 `AbortSignal.timeout(30_000)`；`runLiveNode` 加整体墙钟上限。各一行。

### 1.4 `flow.foreach` 只跑前 3 项

[engine.ts:855](../src/lib/engine.ts:855)

```ts
const items = Array.isArray(resolved) ? resolved.slice(0, 3) : [{ mock: 1 }, ...]
```

这是 mock 期的限制，但它现在对**真实节点也生效** —— 循环体里的 SQL 节点是真跑的。
registry 里声明的 `concurrency` / `continueOnItemError` 引擎一个都不读。

**改**：真实执行时不截断，加 `maxIterations = 1000` 护栏（超了整个节点判失败，
提示先在 SQL 里加 LIMIT）。详见 M5 的 foreach 改造。

---

## 2. 被调研推翻的六个原方案决策

诚实记录：这几条是我前两版方案写错的，按调研结果改正。

### 2.1 ★ `engine.ts` 不能原样搬进 worker

**原方案**（server-runtime-design.md §1.1）：「Node worker 复用 `engine.ts`，几乎零改造」。

**错在哪**：[engine.ts:765](../src/lib/engine.ts:765) 的 `executeFlow` 是一个持有状态的
阻塞 async 循环 —— 执行进度全在闭包里（`order` 数组下标、`dead` 集合、`inLoopBody` 集合、
`failed` 标志、`ctx.nodes`）。原样搬进 worker 只是**把阻塞循环换了个进程**：
进程重启 = 所有在跑的流程永久卡死，而慢 SQL 场景下"在跑"是常态。

**改正**：`engine-core` 不再导出 `executeFlow`，改为导出纯函数

```ts
decide(definition, steps) -> { toRun: Step[], toSkip: string[], finished?: RunStatus }
```

只读输入、不做 IO、不持有状态。执行状态的**当前真相是一张 `steps` 表**，
worker 主循环是「读定义 + 读 steps → `decide()` → 执行 → 写回」。

> 来源：Inngest step.run memoization + Conductor 的 decide() + Camunda async continuation。
> 三个系统殊途同归。
>
> 配套决策（Camunda asyncBefore）：**每个节点边界都是存档点**。理由是硬的 ——
> 节点数个位数到几十，单个 `sql.query` 动辄几分钟，每个边界写一行库的开销可以忽略。

**评审的修正**：Conductor 那套独立的 `pending_decisions` decider queue **不要抄**。
它和 2.2 的 deferred 唤醒循环是同一件事的子集，两个定时扫描表意味着两套租约、
两套 reaper、两处"谁负责推进这个 run"的判定，而它们在慢查询恢复时会同时醒来。
合并成 `steps.next_wake_at` 一列。

### 2.2 ★ 慢查询轮询不能阻塞执行者

**原方案**：worker 崩溃恢复时 re-attach handle 继续轮询。方向对，但**只解决了一半**。

**漏了什么**：[engine.ts:537-596](../src/lib/engine.ts:537) 的 `runLiveNode` 是
`for(;;) { await abortableSleep(3000); poll() }`。一条 Hive 查询跑五分钟，
worker 在这五分钟里**既不能被重启也不能释放**。

**改正**（Airflow Deferrable Operator / Triggerer + Temporal Heartbeat Details + ASL `.sync`）：

| 做 | 不做 |
|---|---|
| `steps` 表加 `status='deferred'` + `progress JSONB`（存 handle）+ `next_poll_at` | 单开 triggerer 进程 |
| 一个共享 async 循环扫 `WHERE status='deferred' AND next_poll_at <= now() FOR UPDATE SKIP LOCKED` | capacity 配额、多 triggerer HA |
| poll 完 done 就置回 ready 让 `decide()` 续跑 | |

**你们已有两处比 Airflow 做得好，必须保留**：`MAX_CONSECUTIVE_POLL_FAILURES = 5`
（轮询失败 ≠ 查询失败）和中止必 `cancelNode`。cancel 的责任要跟着搬 ——
取消一个 deferred 步骤要先按 `progress.handle` 调 `cancelNode`。

> 免费午餐：Airflow 说"Operator 被拆成状态机"很难，那是因为它的 Operator 是命令式代码。
> 本项目的节点本来就只有 submit/poll 两个 HTTP 端点，没有跨调用的局部变量 ——
> 这条约束自动满足。不要因为 Airflow 说难就以为本项目也难。

### 2.3 misfire 默认应该是 `fire_once` 而不是 `skip`

**原方案**：服务停了 3 小时，恢复后默认跳过，"补跑 6 次日报会刷屏"。

**评审推翻**：机器夜里重启，早上 9 点的日报 10 点补发一次**是有价值的**。
`skip` 会让今天彻底没有日报，**而且用户不知道** —— 正好是这个项目要消灭的那个失败模式。

**改正**：默认 `fire_once` + grace 窗口（超过窗口才放弃）。刷屏问题由 2.4 的
重叠策略和第 3 节的告警抑制解决，不该用"干脆不跑"来解决。

### 2.4 表达式换 CEL：从 ★ 降级为 defer

**原方案**：roadmap 里标了 ★「越晚换越贵」。

**评审的反驳**：「越晚换越贵」论证的是**顺序**不是**优先级**。CEL 是 L 的工作量
（新引擎 + 双方言共存 + `extractRefs` 从正则改成走 AST + `validateNode`/复制/重命名三处重写），
要和 M0/M1/M2 抢档期 —— 而那三个才是四大痛点的正解。

更关键：现在真正卡住用户的是三件很具体的小事，**全都不需要换引擎**，合计工作量 S：

1. **链式过滤器** —— 引擎明确抛错"一个 `{{ }}` 只能接一个过滤器"，
   而 `rows | find(...) | table(...)` 是日报里最自然的写法。
   改 `resolveExpr` 的 pipe 分支为循环即可。
2. **补聚合过滤器** `sum` / `unique` / `join` / `sort`
3. **未命中引用报错**（就是 1.1）

三件加起来覆盖了"数据加工能力弱"的大半，而 CEL 换完这三件事还得单独再做一遍。

### 2.5 OR-join 不抄 BPMN 的全局可达性分析

**调研原判**：照抄 Camunda 的 `pre(g)` 预计算 + 运行时活 token 集合求交，
并把 `joinMode='auto'` 定为默认。

**评审推翻**：这是"把大规模系统的复杂度整包搬进来"的典型。BPMN 需要全局分析是因为
它的图有回边、有嵌套 scope、有 non-interrupting 边界事件 —— token 数是动态的。

**本项目的图是无环 DAG**（`flow.foreach` 是一个节点，不是回边）。在无环图上这条**纯局部**规则

> 所有入边的源节点都已到终态（含 skipped），且至少一条不是 skipped

算出的结果与 OR-join **完全等价**，不需要预计算、不需要保存时跑反向 BFS、不需要维护缓存。

而且把 `auto` 设为默认会让 merge 的行为依赖一个画布上看不见的全局分析，
"为什么它等了"变成不可解释 —— 恰好是本项目已经很痛的地方。

**改正**：默认 `joinMode='all'`，用局部规则。省下的力气花在第 3 节的"为什么没跑"可解释性上。

### 2.6 不做「连续失败自动停用」

**调研原判**：抄 Zapier，连续 5 次失败自动 `enabled=false`。

**评审推翻**：Zapier 自动停用是因为它有几百万个 Zap、跑一次就是一次成本，
且用户一定会在邮件里收到停用通知。本项目是 10 条左右的内部流程。

自动停用意味着「Hive 抖了五天，然后日报**永远不再发**，而且没有任何人被告知」——
这是本项目最大痛点（静默不跑）的加强版，这次连 UI 上的定时配置看起来都还在。

**改正**：反过来 —— 连续失败 N 次 → **告警升级**（换更响的通道、@负责人、
流程列表上打持续可见的红标），排程照旧触发。真要防成本失控，
限的应该是 webhook 入口的速率（那才是外部可无限触发的面）。

---

## 3. 方案整个漏掉的一块：告警是旁路，不是节点

这是调研指出的**当前最刺眼的结构性缺陷**，前两版方案完全没提。

现在唯一的通知手段 `notify.wecom` 是 DAG 里的一个节点（[registry.ts:578](../src/registry.ts:578)）。
SQL 节点挂了 + `onError='fail'` → [engine.ts:828](../src/lib/engine.ts:828) 置 `failed`
→ 之后所有节点 skip → **通知节点在下游，永远走不到**。

> 最需要告警的情况，恰好是告警发不出去的情况。

而且整条流程静默停止，没有任何人会知道日报没发出来。

### 改法（Argo `onExit` + Prefect state hooks + DolphinScheduler alert-server）

**三件事，都不大：**

**(1) `FlowDefinition` 加 `onExit` 子图** —— 一个不参与主 DAG 的小子图，
run 进终态后**无条件执行**（成功也跑，可以只在模板里判 `status`）。
新增变量命名空间：

```
$.workflow.status      success | error | canceled
$.workflow.failures    [{nodeId, nodeName, nodeType, code, message, finishedAt}]
$.workflow.duration
$.workflow.name
```

在 [vars.ts](../src/lib/vars.ts) 的 `availableVars` 里加一组"流程运行信息"候选项，
和现有 `$.trigger.*` 同一层，成本很小。配合现成的 `transform.template` + `notify.wecom`
就能渲染一条像样的失败告警。`onExit` 自身失败只记事件，不再套娃。

**(2) 告警投递必须旁路** —— worker 在 run 进终态时写一行 `alerts(id, run_id, kind, status, attempts, next_retry_at, dedup_key)`，
由同一个 worker tick 投递并重试。**发送失败只写事件、绝不改 run 状态** ——
告警是运行的旁路，不是运行的一环。

**(3) ★ 告警抑制必须和告警同批上线** —— 这一版一口气新增了四路告警
（终态、SLA miss、连续失败、misfire）。数据平台挂半小时，十条流程各失败三次，
群里就是几十条消息，接着所有人把这个群设免打扰 —— 告警系统失效的标准路径，
**而且失效之后没人知道它失效了**。

最小形态：`alerts` 表加 `dedup_key`（flow + 错误码 + 节点）+ 一个窗口判断，
同组在抑制窗口内只发一条并附"累计 N 次"。成本 S。

**(4) SLA miss 的判定基准取 `scheduled_time` 而不是 `started_at`** ——
否则一个因为上游堵住而**根本没开始**的任务永远不会 SLA miss，正好漏掉最该报警的情况。

---

## 4. 机制目录（按里程碑）

每条格式：**机制名**〔来源〕→ 现状 → 改动 → 坑。

### M0 · 存储与发布 ✅ **已完成**

> **服务端**
> - `migrations/001_flows.sql` —— flows / flow_versions / audit 三表
> - `db.py` —— 连接池 + 裸 SQL 迁移 + **没配 DATABASE_URL 时优雅降级**（503 + 前端继续用 localStorage）
> - `flowdef.py` —— 纯校验，**只拒绝不修复**，33 用例，不需要数据库
> - `flowstore.py` —— 草稿 / 发布 / 版本 / 归档 / 审计
> - `main.py` 的 `/api/flows*` 七个端点；`/health` 增加 `storage` 字段
> - 根目录 `docker-compose.yml`（当前只起 Postgres，M6 再补其余服务）
>
> **前端**
> - [library.ts](../src/lib/library.ts) 改成**双后端**：服务端可用就以它为准，
>   否则整套退回 localStorage。**本地那份永远写** —— `beforeunload` 只能同步保存
> - 工具栏「发布」按钮 + 版本号显示；本地模式下不出现（没有版本这个概念）
> - 首页列表读服务端；只存在本地的流程**标出来但不自动上传**，一键上传
> - 服务端读失败退回本地时**把原因说出来**，不静默
> - 19 例前端测试打桩 fetch 跑通整条链路（浏览器里走不到服务端模式）
>
> **门禁**
> - `npm run check:flows` —— 用后端下发的注册表逐条校验存量流程，
>   退出码非 0 可直接当 CI 门禁
>
> **已对真实 Postgres 验证**（Homebrew postgresql@16，5432）：
> `test_flowstore.py` 32/32、七个端点端到端、迁移与库结构、发布事务、审计链路；
> 浏览器实测服务端模式（列表、只在本地的流程横幅与上传、发布 v1、
> 草稿改动显示「发布 v2」、改回后服务端判定无差异）。
>
> 浏览器验证抓到一个测试和类型都盖不住的 bug：**首页列表没等 health 探完**，
> `storageMode()` 是同步读的，探测没回来时一律是 'local' —— 于是首页拿本地那份
> 当全部内容显示，服务端上的流程一条都不出现，而界面看着完全正常。已修。

**版本快照不可变**〔n8n versionId / Temporal 版本钉住〕
- 现状：[store.ts:1039](../src/store.ts:1039) `version: 1` **硬编码** —— 字段存在但永远是 1，**现在根本没有版本概念**
- 改：`flows` / `flow_versions` 两表，发布即新版本；`runs.flow_version` 钉住当时快照
- 坑：运行记录必须读 `runs.flow_version` 取定义，**不能读 `active_version`**（redrive 时尤其致命）

**pinData 的生产隔离**〔n8n〕
- 现状：语义已在 [types.ts](../src/types.ts) 写明（生产触发忽略），但没有生产触发
- 改：`POST /api/flows/{id}/runs` 收到 `mode='production'` 时**服务端直接丢弃 pinData**，不信任客户端；normalize 时单条 pin > 256KB 拒绝；画布上被 pin 的节点画紫色角标，运行完在 RunPanel 顶部横幅列出本次用了几个固定数据

**★ 存量流程的批量静态校验**〔Airflow `test_dag_integrity` / Schema Registry 兼容检查〕
- 现状：完全没有。[types.ts:52](../src/types.ts:52) 的注释自己描述了这个坑 ——
  manifest 全量覆盖 registry，"一上线就没，而且**只在线上没，本地永远测不出来**"
- 改：CI/发布前对**库里全部流程**跑一遍 `normalizeFlowDefinition` + `validateNode`，
  产出"哪些流程会因这次节点 schema 变更失效"；节点 schema 的破坏性变更
  （删字段、改名、收窄 enum）必须伴随 `typeVersion` 升级才允许合入
- 为什么现在做：M0 之后流程集中到服务端，一次变更能同时打坏所有人的日报

**★ 最小身份与审计**〔Camunda / n8n audit log〕
- 现状：`server/sql_service` 里搜不到任何 auth/user/login。设计文档的 `flow_versions` DDL
  里放了 `created_by` 字段，但**整个系统里没有任何东西能填它** —— 缺的不是表，是 actor 的来源
- 改：**不做 RBAC**。只做两件：反向代理把 SSO 用户名带进请求头当 actor；
  一张 append-only 的 `audit(actor, action, target_type, target_id, at, diff_digest)`，
  记流程发布/删除、手动运行与补跑、凭证轮换、webhook 密钥轮换
- 为什么：M0 共享流程 + M3 开放 webhook + 凭证集中，三件叠加后
  "谁把日报 SQL 改坏了""谁手动补跑了一个月导致刷屏"全都无法回答

---

### M1 · 服务端引擎 · 6-8 天（原估 4-6，因 2.1/2.2 上调）

**★ `decide()` 纯函数 + 节点边界存档**〔Inngest / Conductor / Camunda〕—— 见 2.1

**★ deferred 状态 + handle 持久化**〔Airflow Triggerer / Temporal Heartbeat〕—— 见 2.2

**steps 物化表**〔Inngest memoization〕
- 现状：设计文档只规划了 `run_events`。fold 事件流比直接查表贵且容易出错
- 改：`run_events` 之外建 `steps` 表，`(run_id, node_id, loop_index)` UNIQUE，
  列 `status / input / output / error / attempt / handle / progress / heartbeat_at / next_wake_at`。
  **`run_events` 做时间线和 SSE 增量，`steps` 做执行状态的当前真相**
- 免费午餐：node id 天然是 step id（画布保证唯一），不需要 Inngest 的命名纪律；
  副作用只可能发生在节点里，不需要"副作用必须包在 step.run 里"这条纪律

**StepStatus 状态机**〔Airflow TaskInstance，**评审下调**〕
- 调研原判：扩成 11 态。**评审推翻** —— Airflow 需要 11 态是因为 scheduler/worker/triggerer
  是三个进程，状态枚举兼职承担进程间交接协议；本项目单 worker + 数据库队列没有交接态。
  11 态的代价是 RunPanel/NodeDetailView/运行列表/SSE/清理/告警全要多一个分支，
  而 `up_for_retry`/`timeout`/`crashed`/`failed` 用户根本分不清
- **改正：7 态 + 两个正交字段**
  - `status`: `queued | running | waiting | success | failed | skipped | canceled`
  - `failure_kind`: `business | infra | timeout | canceled`（仅 failed 时有意义）
  - `attempt` / `next_retry_at`
- 坑：每个非终态都要有兜底扫描，否则出现"卡在 queued 谁也不管"的幽灵态

**运行记录三段式**〔Dify inputs / process_data / outputs〕
- 现状：`StepRun` 有 input（"表达式解析后的实际入参"）和 output，**没有 process_data**。
  但 `sql.query` 的 `renderedSql` 已经有了 —— 只是 submit 那次返回的被引擎丢掉了
  （[engine.ts:554](../src/lib/engine.ts:554) `const { handle } = await submitNode(...)`）
- 改：`StepRun` 加 `processData?`；三个节点各自填 —— `sql.query` → `{renderedSql, engine, queue, jobId}`（提交那一刻就记）；`http.request` → `{method, url, requestHeaders, attempts}`，headers 走现成的 `secrets.ts` 脱敏；`notify.wecom` → `{msgtype, renderedContent, targetMasked}`，直接复用现成的 [MessagePreview.tsx](../src/components/MessagePreview.tsx) 渲染

**★ "这个节点为什么没跑"的可解释性**〔Airflow Dependencies Blocking Task〕
- 现状：三套灭活逻辑（`dead` 集合、`reachableFrom` 全图灭活、循环体内的 `iterDead`）
  产生的 skipped 在 UI 上**长得一模一样**
- 改：每次 skip 写结构化原因 —— `skipped_by:{nodeId, port}` / `upstream_failed` /
  `unreachable` / `join_waiting_on:[edgeIds]`，运行详情页当一等信息显示
- 为什么必须和调度改造同批：**这是替换调度逻辑时唯一的验证手段**。没有它，
  局部 join 规则改完之后一个节点该跑没跑，只能靠肉眼比对画布。事后补要重跑所有历史

**★ 流程级回归测试（golden run 重放）**〔n8n Evaluations / Airflow `dag.test()`〕
- 现状：`test/` 只有四个纯函数单测，**`engine.ts` 1036 行零测试**，也没有 CI。
  而这份方案要动 engine 的条目有二十多条
- 改：把一次真实运行的每步实参与输出存成 fixture，重放到当前引擎
  （上游用 fixture 输出替代真实调用），diff 本次输出与基线
- 为什么成本异常低：`pinData` 和 `StepRun.input` 已经是现成的 fixture 载体，
  M1 之后 `steps` 表就是天然的基线来源。真正要写的只有一个 replay host 和一个 diff
- 不做这条的后果：连续二十多处 engine 改造，**每一步都用生产日报当测试用例**

**★ 端到端关联 ID 下推**〔W3C traceparent / Google sqlcommenter〕
- 现状：链路 浏览器 → api → sql_service → 数据平台，**两个方向都断**。
  拿到一个跑了 40 分钟的 Hive job 无法反查是哪条流程；拿到一次失败的 run
  也无法在平台侧定位那个 job
- 改：`run_id + node_id + attempt` 作为 `X-Request-Id` 一路透传；
  **提交给 Hive/Presto 的 SQL 前拼一段注释** `/* flow=daily_report run=r_123 node=q1 */`
- 成本几行字符串拼接，收益是"9 点谁在打爆 Hive"第一次可回答 ——
  而这正是 backfill、foreach 放开并发、重试三件事上线后必然要回答的问题

**大 output 外部化**〔Dagster IO Manager，**评审下调**〕
- 调研原判：建 `OutputStore` 接口 + `StepAddr` 类型。**评审推翻** ——
  只有一个落点（单机文件系统），为一个实现定义接口是教科书式的过早抽象
- **改正**：只要那个核心思想 ——「**地址由步骤身份确定性推导，因此不需要映射表**」，
  写成一个 30 行的 `putLarge(runId, nodeId, iter, name, value)` 函数，
  地址 `runs/{runId}/nodes/{nodeId}/{iter}/{name}.json`，清理时按 runId 目录整体删
- ★ 评审点破的问题：**大 output 阈值在三处给了三个数**（4MB / 64KB / 256KB），
  说明这条从来没被真正拍板。

  **已拍板：256 KB（序列化后的字节数）。** 理由：
  - 一次典型 SQL 结果（1000 行 × 10 列）序列化后大致 100-300 KB。
    64 KB 会把**常见情况**也推去外部存储，为最普通的路径加一层间接
  - 4 MB 会让 `run_events` 和 SSE 推送迅速变胖，而单条运行的价值不随体积增长
  - 256 KB 正好卡在"典型结果留在库里、真正的大结果外部化"之间

  实现时这个数字只能有**一个**出处（`engine-core` 里一个导出常量），
  三份文档各写一个数正是它一直没落地的原因
- 坑：`pinData` 不要进 run 生命周期（run 清理时不能删它），
  共用信封但地址前缀用 `flows/{flowId}/pin/{nodeId}.json`

---

### M2 · 调度器 · 2 天

**★ 调度幂等：唯一约束 + advisory lock**〔Airflow / Quartz〕
- 改：`runs` 表加 `UNIQUE (flow_id, trigger_kind, scheduled_time)`。
  **锁是性能优化，唯一约束才是正确性保证 —— 两者都要**
- ★ `scheduled_time` 必须是**独立字段**，不能复用 `started_at`。
  它是整份清单里最不可事后追加的一个字段 —— 日期基准、SLA 判定、backfill、幂等键
  四件事全挂在它上面。而 [engine.ts:388](../src/lib/engine.ts:388) 现在
  `scheduledFor: ctx.run.startedAt`，等于把这个概念焊死了
- 坑：键里必须含 `trigger_kind`，否则同一时刻的手动重跑会被当成重复

**★ 重叠策略**〔GitHub Actions concurrency group + Temporal overlap policy〕
- 为什么必须和调度器同批：`trigger.schedule` 的 interval 模式最小 1 分钟
  （[registry.ts:70](../src/registry.ts:70)），而 Hive 查询跑几分钟 ——
  **调度器上线第一天就会出事**：第二次触发在第一次没跑完时启动，群里两条日报，
  两条 SQL 同时压平台
- 改：`flows` 表加 `concurrency_key`（默认 flow_id，允许写模板表达式做按参数分组）
  和 `on_overlap`（`skip` | `queue_latest_only` | `cancel_running`，**默认 skip**）
- ★ 被跳过的 run 必须在列表里**显式显示**成"因上一次未结束而跳过"，不能让它消失 ——
  否则用户又得到一个"我以为它跑了"

**misfire 默认 fire_once + grace** —— 见 2.3

**★ 触发器装载状态回显**〔n8n Active 开关 / Temporal `nextActionTimes` / Airflow 调度器横幅〕
- 这是"定时触发器是空的、用户以为会跑"这个痛点**唯一的直接解药**，而 160 条机制里
  没有一条讲"怎么让用户知道它到底会不会跑"（评审补的）
- **(a) 不依赖 M2，今天就能做**：一行横幅「定时触发尚未接入调度器，本流程不会自动运行」
  就消灭了当前最严重的失败模式
- (b) 排程配置旁显示按服务器时区算出的**下 3-5 次真实触发时刻**。
  这不与 [schedule.ts](../src/lib/schedule.ts) 的克制冲突 —— `describeCron` 的"翻不动就原样回显"
  是怕把 cron 语义解释错，而算未来触发时刻是确定性计算，不存在翻错
- (c) 调度进程写心跳行，超过一个周期没心跳就在所有页面顶部挂红条 ——
  调度器静默死掉 = 回到今天的状态**且更隐蔽**（这次用户有理由相信它在跑）

---

### M3 · Webhook 触发器 · 2-3 天

保持 [server-runtime-design.md §5](./server-runtime-design.md) 的设计（body 双通道、
认证三档、四层限流、幂等、production 忽略 pinData、监听一次测试模式），
调研补充/修正三处：

**`flow.end` 的 outputs 声明**〔Dify Answer/End 节点〕
- 现状：`flow.end` 只有一个 `result` 字符串
- 改：改成 outputs 映射表 `[{variable, valueRef}]`，用现成的 [RefField](../src/components/RefField.tsx) 渲染。
  **`lastNode` 响应模式返回"走到的那个 flow.end 的 outputs"，而不是"末节点输出"** ——
  后者在多出口流程里没有定义
- 流式输出（Dify 的 answer_generate_route）完全跳过，内部数据工具没有价值

**`flow.respond` 第三种响应模式** → **defer**（评审：原清单自相矛盾）
- 一处写"responseMode 保持两档，显式 skip responseNode"，另一处又要加第三档 —— 实现者按哪条都会被推翻
- 正确顺序：M3 先上 `immediate` + `lastNode` 两档；等真撞上"流程后半段有 Hive 慢查询导致 lastNode 必然超时"再决定

**多触发器共存的决策点**
- [graph.ts:69](../src/lib/graph.ts:69) 现在 `entries.length > 1` 直接报错，
  [store.ts:1042](../src/store.ts:1042) 的 `toDefinition` 只找 `trigger.schedule` 一个节点
- 加 Webhook 后必须决策：一条流程能否同时挂手动 + 定时 + Webhook？
  n8n 可以。**建议可以** —— 否则"日报既定时发也支持手动触发"这个最常见的需求要建两条流程

---

### M4 · Python 代码节点 · 4-5 天（原估 3-4）

安全边界（`code` 字段禁止模板插值 + 沙箱环境变量清空）见
[server-runtime-design.md §10](./server-runtime-design.md)，**红线不变**。调研补齐了实现细节：

**沙箱限制清单补 5 项**〔Windmill / dify-sandbox / Judge0 / Piston 的共性〕
- 原清单缺：`rlimit_nofile=64`、`rlimit_fsize=64MB`、并发数上限、**输入数据大小上限**、
  每次执行后销毁不复用
- ★ **stdout/stderr 和 fd3 返回值是两个独立的口子**，只限一个另一个照样能撑爆 `run_events`。
  Windmill 和 Judge0 都是分开设的 —— stdout/stderr 各 256KB，超限截断并标 `logsTruncated: true`
- 每一项限制配一条人话错误信息（"内存超过 512MB 上限"而不是 `Killed`）

**★ traceback 剥壳的具体做法**〔Windmill / n8n Code 节点〕
- 原方案只写了"带行号、剥掉包装层"，**没有实现细节，而全部难点恰好在细节里**
- 具体套路：
  ```python
  compile(src, filename="<user_code>", mode="exec")
  linecache.cache["<user_code>"] = (len(src), None, src.splitlines(True), "<user_code>")
  while tb and tb.tb_frame.f_code.co_filename != "<user_code>": tb = tb.tb_next
  ```
- ★ **不给用户代码加任何包装行** —— 入口是 `def main(inputs)`，让用户自己写这一行，
  runner 只 exec 顶层再从 namespace 取出 main 调用。**行号天然对齐，不用做减法**
- `StepRun` 加 `errorDetail?: {type, message, lineno, col, sourceLine, traceback}`
- 坑：用户自定义异常类反序列化到父进程时类不存在，`errorDetail.type` 只能存类名字符串，不要 pickle

**★ 返回值 JSON 序列化兜底**〔Zapier/Make/n8n 各自的踩坑史〕
- 必然性可以从现有链路直接推出来：`sql.query` 取回 rows → 代码节点用 pandas 加工 →
  `notify.wecom` 发出去，中间**必然出现** Decimal（金额）、datetime（日期分区）、NaN（空值）
- 新增 `server/sandbox/encoder.py`，runner 出口唯一走它：
  - ★ `json.dumps(..., ensure_ascii=False, allow_nan=False, default=fallback)` ——
    **`allow_nan=False` 是关键**，默认会吐 `NaN` 字面量，前端 `JSON.parse` 直接炸，
    而 SQL→pandas 管道里 NaN 遍地
  - fallback 分发：datetime/date → isoformat；Decimal → str（保精度）；set → list；
    bytes → base64 包 `{"__type":"bytes"}`；numpy 标量 → `.item()`；ndarray → `tolist()`；
    DataFrame → `to_dict("records")`；dataclass → `asdict()`；其余抛错**且消息带路径**
    （"结果的 `rows[3].amount` 是 Decimal，无法序列化"而不是只报类型名）
  - 顶层强制 dict，**不要自动包成 `{"items": ...}`**
- 坑：Decimal→str 后 `{{ }}` 里的数值比较仍工作（`Number()` 转），但 `|table` 渲染观感会变 ——
  有意取舍，写进节点文档。NaN→null 会把"缺失"和"非数"混为一谈，同样写文档

**worker 队列隔离**〔Temporal Task Queue〕
- `runs` 表**现在就加** `queue TEXT DEFAULT 'default'`，worker 按 `--queues` 过滤认领。
  现在只有一个队列，加字段是为了代码节点能跑在受限沙箱 worker 上 —— 加字段比事后改调度便宜得多

---

### M5 · 可靠性与数据加工 · 4 天（原估 2）

**★ 服务端错误码分层**〔ASL 错误码 + Temporal nonRetryableErrorTypes + Conductor〕
- 现状：[engine.ts:573](../src/lib/engine.ts:573) 判断"能不能重试"靠**匹配中文串**
  `已不在数据平台上` —— 改一个字文案就静默失效
- 改（**服务端先行**）：`main.py` 的错误响应统一成 `{code, retryable, message}`

  | 场景 | code | retryable |
  |---|---|---|
  | 参数/占位符错 | `SQL_PARAM_ERROR` | false |
  | 语法错、表不存在 | `SQL_QUERY_ERROR` | false |
  | 结果被清理(410) | `RESULT_EXPIRED` | false |
  | 机器人票失败(502) | `PLATFORM_AUTH` | true |
  | 服务不可用(503) | `SERVICE_UNAVAILABLE` | true |
- 坑：`nonRetryableErrorTypes` 按字符串匹配，改了 code 名策略静默失效。
  **code 集合定义成 Python 和 TS 各一份常量表 + 一条对齐测试** ——
  就像 registry.ts 和 manifest.py 已有的对齐约定

**RetryPolicy 真正落地**〔Temporal〕
- `types.ts` 改成 `{maxAttempts, initialMs, backoffCoefficient, maximumIntervalMs, nonRetryableErrorTypes}`
- 第 n 次间隔 = `min(initialMs × backoffCoefficient^(n-1), maximumIntervalMs)`
- 默认值：`sql.query` `{5000, 2, 60000, 3, ['SQL_QUERY_ERROR','SQL_PARAM_ERROR','RESULT_EXPIRED']}`；
  `notify.wecom` `{2000, 2, 10000, 5, []}`
- ★ **必须排在幂等键之后**，否则重试 = 群里收到重复日报

**幂等键三处**〔Temporal WorkflowIdConflictPolicy〕
- run 级：定时 `sched:{flow_id}:{scheduled_time}`；webhook 用请求头或 raw body 的 sha256；手动不填
- 节点级：`sha256(run_id + node_id + iteration)`。★ **键里必须含 iteration 但不含 attempt** ——
  含了 attempt 等于没有去重（每次重试 key 都变）
- 服务端：`node_idempotency(key PK, response JSONB, created_at)` 表，24h TTL，
  `notify.wecom` 和 `http.request` 的 execute 端点先查后写

**★ Redrive：从失败节点重跑**〔Step Functions RedriveExecution + Make incomplete executions + Camunda Incident〕
- 现状：失败之后**连"重跑"按钮都没有** —— store 只有 `startRun`（从头）和 `testStep`（单节点）两个极端
- 兑现的损失是每天都在发生的：Hive 已经跑完五分钟、结果已经拿到，只是发企微时 500 了，
  **今天整条运行的价值归零**
- 改：`runs` 加 `redrive_of` + `redrive_count`；**新建一条 run**（运行列表一行一次运行更好理解）；
  把源 run 里 success 的步骤输出复制成 `node.succeeded` 事件（payload 加 `replayedFrom`）；
  `POST /api/runs/{id}/redrive`；UI 在失败节点上放「从这里重跑」
- ★★ 两个护栏：
  - **必须用源 run 的 `flow_version`**（不是 `active_version`）
  - **必须沿用源 run 的 `scheduled_time`** —— `date.compute` 和表达式的日期基准都是
    `ctx.run.startedAt`，redrive 时若用当前时间，复用的上游 SQL 结果是昨天的、
    新算的日期是今天的，两者对不上**且完全静默**
- 校验大 output 的 `$ref` 还在（保留期清理过就没了），不在就只能整条重跑，UI 要说清

**★ foreach 的 outputCollection + 并发 + 容错**〔BPMN Multi-Instance + ASL Map〕
- 现状：除了 1.4 的 `slice(0,3)`，更要命的是 **foreach 的输出只有 `{results:[{index,item}]}`，
  拿不到每次迭代产出了什么**（体内节点的 `ctx.nodes` 每轮被覆盖）。
  所以"对每个 vid 查一次然后汇总"这个最自然的用法**今天表达不出来**
- 改：加 `collect` 引用表达式 + `collected` 数组输出；读 registry 里已声明的
  `concurrency` / `continueOnItemError`；加 `toleratedFailurePercentage`；`maxIterations=1000` 护栏
- 配套（Airflow Dynamic Task Mapping）：`steps` 表主键含 `loop_index`，每次迭代物化一行 ——
  现有的 `iteration` 字段直接映射过去，几乎零语义改动。运行详情页做成**状态网格**：
  第 7 个城市的 SQL 挂了，用户能直接看到是第 7 个、看到它的输入、**只重跑它**

~~**表达式三件小事**~~ ✅ 已完成 —— 见 2.4。链式过滤器、`sum`/`unique`/`join`/`sort`、
未命中报错三件都已落地，覆盖了"数据加工能力弱"的大半。CEL 继续 defer。

**★ 慢查询护栏**〔Hive strict mode / Presto `max-scan-physical-bytes` / BigQuery dry-run〕
- 为什么现在做：这一版同时做三件会**成倍放大查询量**的事 —— backfill（一次展开一个月 = 30 个 run）、
  foreach 从 3 项放开到 1000 项、重试。任何一件单独上线还好，三件叠加在共享的
  Hive/Presto 集群上，**代价会外溢到别的团队**，而本项目今天对"这条 SQL 有多贵"一无所知
- 改：提交前静态检查（无分区谓词、`SELECT *` 且无 LIMIT → 拒绝或强制确认）；
  平台支持则 dry-run 估扫描量；每流程每天提交次数与并发上限
- 注意：并发上限限的是槽位不是规模 —— **一条全表扫的 SQL 只占一个并发槽**

---

### M6 · 部署交付 · 2 天

保持 [server-runtime-design.md §7](./server-runtime-design.md)，补一条：

**告警抑制配置**（见第 3 节 (3)）与 `alerts` 表保留策略一起上线。

---

## 5. 明确不抄（附理由）

评审推翻的和调研自己标 skip 的，合并列出。写下来是为了以后不用重新讨论。

| 不抄 | 来源 | 为什么 |
|---|---|---|
| **BPMN 全局 OR-join 分析** | Camunda | 无环 DAG 上局部规则完全等价，见 2.5 |
| **`edge_tokens` 物化表** | Camunda ACT_RU_EXECUTION | 边状态可由 steps 派生；多一张要保持一致的表 = 多一类只在崩溃恢复时暴露的故障 |
| **11 态状态机** | Airflow | 交接态在单 worker 架构里没有对应物，见 M1 |
| **独立 decider queue** | Conductor sweeper | 与 deferred 唤醒循环是同一件事，两个扫描表会同时醒来 |
| **Boundary Event 超时出口** | BPMN | 被"超时三件套 + 错误码 + error 出口"完全覆盖；两套出口会产生"谁先谁后"的新语义问题 |
| **IOManager 接口抽象** | Dagster | 只有一个落点，教科书式过早抽象；留那个 30 行函数 |
| **Sticky execution** | Temporal | 它存在的唯一理由是避免重放代码，而本项目没有重放 |
| **command/event 双向重放** | Temporal | 流程是数据不是代码，无需 determinism |
| **连续失败自动停用** | Zapier | 见 2.6，是"静默不跑"的加强版 |
| **告警组（接收人组）抽象** | DolphinScheduler | 三个人的团队过度设计；`notify_config` 里放一个 credentialId 就够 |
| **saga 补偿栈** | Temporal | DAG 里补偿就是画在画布上的一条 error 边，比让用户理解补偿栈直观 |
| **CEL 换引擎** | — | defer，见 2.4 |
| **流式输出 / answer_generate_route** | Dify | 内部数据工具没有价值 |
| **item-based 隐式 fan-out** | n8n | 数据是"一个结果集"不是"一批 item"，混进来会让 merge 的下标语义失控 |
| **K8s / Redis / RabbitMQ / Temporal 本体** | — | 个位数并发，Postgres + SKIP LOCKED 够用 |
| **代码节点联网 / 装包** | — | 走 http.request（URL 可审计）；装包牵扯镜像构建与供应链审查 |
| **多进程 triggerer / capacity 配额** | Airflow | 塞进现有 worker 即可 |
| **ZooKeeper 容错** | DolphinScheduler | 数据库心跳 + reaper 够用 |

---

## 6. 修订后的排期

| 阶段 | 内容 | 原估 | 新估 | 变化原因 |
|---|---|---|---|---|
| **P0** | 四个已上线缺陷（第 1 节） | — | **1.5 天** | 新增。SSRF 和静默空串是正确性/安全问题 |
| M0 | 存储与发布 + 批量校验 + 审计 | 2-3 | **3-4 天** | 加静态校验门禁、最小审计 |
| M1 | 服务端引擎（decide + deferred + steps 表） | 4-6 | **6-8 天** | 2.1/2.2 推翻原方案；加 golden run 测试、可解释性、trace 下推 |
| M2 | 调度器 + 重叠策略 + 状态回显 | 1-2 | **2 天** | 加重叠策略（不加上线第一天出事）、触发器状态回显 |
| M3 | Webhook | 2-3 | **2-3 天** | 不变 |
| M4 | Python 代码节点 | 3-4 | **4-5 天** | 补 traceback 剥壳、序列化兜底、5 项沙箱限制 |
| M5 | 可靠性 + 数据加工 | 2 | **4 天** | 加 redrive、foreach outputCollection、错误码分层、慢查询护栏 |
| M6 | 部署交付 | 1-2 | **2 天** | 加告警抑制 |
| — | **告警旁路（第 3 节）** | — | **2 天** | **全新**，跨 M1/M2 |
| | | **15-22** | **26-32 天** | |

依赖不变：

```
P0（独立，随时）
M0 → M1 → M2 / M3 / M5
     M4 可与 M2/M3 并行
     告警旁路 建在 M1 之上，与 M2 同批
```

### 如果只能做 8 件事

评审给出的排序（按"真实痛点 ÷ 实现成本"，不是按系统知名度）：

1. **`decide()` 纯函数 + 节点边界存档** —— 另外五条的地基，单独就消灭第一痛点
2. **deferred 状态 + handle 持久化** —— 没有它，第 1 条在本项目最常见的场景下白做
3. **调度幂等（唯一约束 + advisory lock + `scheduled_time` 独立字段）** —— 比值最高，半天换"定时真的会跑且只跑一次"
4. **重叠策略** —— 第 3 条的正确性配套，不加则调度器上线第一天出事
5. **告警旁路 + SLA** —— 把"静默失败"整类问题一次性关掉
6. **超时三件套 + 错误码分层 + RetryPolicy** —— 含两个今天就存在的 bug（1.3）
7. **Redrive** —— 建在第 1 条上几乎免费，兑现的是每天都在发生的损失
8. **foreach outputCollection + 并发 + 链式过滤器** —— 唯一直接对着"数据加工能力弱"的一条
