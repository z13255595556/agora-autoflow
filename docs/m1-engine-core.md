# M1 · engine-core 与 decide() 重构

[improvement-plan.md](./improvement-plan.md) 的 M1 展开。**与本文件冲突处以本文件为准** ——
§2.1 / §2.2 / §2.5 的三条设计被对抗性评审推翻了。

产出依据：对 `executeFlow` 的一轮系统性拆解 —— 33 处可变状态、66 条可观察语义
（其中 **55 条标为 silent-wrong：坏了不报错**）、3 路对抗性评审（表达力 / 崩溃恢复 / 等价性），
其中一路判定 `broken`。

---

## 1. 被推翻的设计

### 1.1 ★ `decide(definition, steps)` 签名不够 → `decide({definition, nodeTypes, run, steps, now})`

两条硬缺口，各自都会导致**真实的副作用**：

**(a) 取消是 run 级事实，steps 里没有它的投影。**
run 处于 `canceling`、steps 里 A=success / B=queued 时，只看 steps 的 `decide()` 会判 B 可跑，
worker 认领 B 之后**真的把企微消息发出去** —— 取消一条流程反而多发一条。

**(b) 执行判定依赖注册表，而注册表不在 FlowDefinition 里。**
`visualOnly` 剔除（[engine.ts:821](../src/lib/engine.ts)）、`hasInput===false` 的触发器免活性判定、
`flow.if` 的 `true`/`false` 口、`foreach` 的 `each`/`done` 口 —— 唯一来源都是 `NODE_TYPE_MAP`
（[registry.ts:676](../src/registry.ts)，一个被 `applyBackendNodes` **热覆盖的全局可变 Map**）。
`FlowDefinition` 里只有 `type` 字符串和 `typeVersion`。

→ `flow_versions` 需要加一列 `registry_snapshot`，发布时钉住 NodeType 的执行相关子集
（ports / hasInput / visualOnly / runtime.kind / pollIntervalMs / policy）。
**不这么做，改一次 manifest 就会改变历史运行记录的重放结果。**

### 1.2 ★ `toSkip: string[]` → `Array<{nodeId, loopPath, reason}>`

裸 `nodeId` 定位不到 steps 的主键 `(run_id, node_id, loop_path)`。foreach 展开 3 项、
体内 if 在 i=1 灭掉 D 时，worker 拿到 `'D'` 只能猜：写 `loop_path='{}'` 造出顶层幽灵行，
或写全部 loop_path —— **把已 success 的 i=0/i=2 覆写成 skipped**。

`reason` 也必须由 decide() 给：worker 反推不出「是 if 灭的、全局 fail-fast 灭的、还是无入边」，
而「这个节点为什么没跑」是替换调度逻辑时**唯一的验证手段**。

### 1.3 ★★ §2.5「局部规则在无环 DAG 上与 OR-join 等价」——**对普通 join 成立，对 foreach 不成立**

反例，会静默多发消息：

```
q1 → loop(foreach) --each--> send(notify.wecom)
```

3 次迭代各发一条、`loop` 置 success 之后，下一个 tick 局部规则看到
「send 的唯一入边源 loop 已终态且非 skipped」→ 判 send 就绪 → loopPath 取默认 `{}`
→ 与已有的 `{0}/{1}/{2}` 主键不冲突 → **第 4 条企微消息发出去，运行记录还是绿的**。

`fanout=0` 更糟：Hive 返回 0 行，今天是「一条都不发」，换成局部规则变成
「发一条本不该发的」—— 从静默不发翻成**静默错发**。

→ 必须加循环作用域：节点 n 在 loopPath p 上就绪 ⟺ p 与 `loopScope(n)` 相容，
且每条入边源在 p 上（each 口边取 p 的父路径）都到终态。

### 1.4 join 的活性判定：「不是 skipped」把 failed 和 canceled 也算活了

- **canceled**：reaper 把在跑的 A 写成 canceled（终态、非 skipped）→ 下一 tick 判 B 可跑
  → B=notify.wecom 在取消过程中真的发消息
- **failed**：`errButContinue`（[engine.ts:948](../src/lib/engine.ts)）读的是**源节点**的 `onError`，
  是一条独立例外规则，不是「非 skipped」顺带覆盖得了的

**正确规则**：活 = ∃ 入边源为 success，或（源 failed 且**该源节点** `onError='continue'`）；
canceled 一律不算活。完成 = 所有入边源到终态。

### 1.5 `deferred` 不做成第 8 个状态 → `status='waiting'` + `wait_kind`

`deferred`（等平台任务）和 retry backoff（等退避时钟）在调度器眼里是同一件事：
一行没有执行者持有、带一个到期时刻、到点由同一个循环唤醒。做成两个 status，
`decide()`、兜底扫描、UI 色板、SSE 各要多一个分支，而分支里的代码逐字相同。

`WaitKind = 'poll' | 'retry' | 'fanout'`，与 `failure_kind` 完全对称。

### 1.6 `edge.port` 的缺省值只能有一个出处

[store.ts:1057](../src/store.ts) 导出时**只在 `sourceHandle` 存在且 `!== 'out'` 时才写 `port`**。
所以一条从 `flow.if` 拉出但没带 handle 的边，在 definition 里 `port` 是 `undefined`。

今天 `(e.sourceHandle ?? 'out') === port` 让它既不匹配 `'true'` 也不匹配 `'false'`
→ 两侧都不灭活、下游全跑。若按 `edge.port === exit_port` 直接比，`undefined` 两边都不等
→ 该边被判死 → 下游全被 skip。**同一份定义，行为从「全跑」翻成「全不跑」，完全静默。**

→ `portOf(edge) = edge.port ?? edge.sourceHandle ?? 'out'`，全仓一个出处。
现在它散在 [check-flows.ts:52](../scripts/check-flows.ts)、[store.ts:1057](../src/store.ts)、
[engine.ts:768](../src/lib/engine.ts) 三处。

### 1.7 `makeSeq` 共享可变伪随机流 → 按步派生

`makeSeq(42)` / `makeSeq(7)` 的取值依赖「在它之前有几个节点调用过」。
一旦并发，同一份 fixture 会随调度顺序改结果 —— 而那正是 golden 测试最不能容忍的。
趁 `mockOutput` 的形参还写作 `_seq`（一次没用上）改，成本为零。

### 1.8 `CHECK (wait_kind<>'poll' OR progress ? 'handle')` 反而禁掉了唯一崩溃安全的写法

那条约束看着像安全约束，实际禁掉了「先落一行『我即将 submit』再打请求」——
因为那一刻还没有 handle。

真正的窗口在 [engine.ts:723](../src/lib/engine.ts)：submit 返回之后、handle 落库之前。
此刻 `status='running'`、`progress='{}'`，与「worker 刚认领还没发请求就死了」**完全同形**。
reaper 查 `policy.idempotent`（registry 里 sql.query 写着 `true`）判定可以重跑
→ 平台上两个 Hive 大查询并行、第一个没人持有也没人取消、跑满 6 分钟白烧。

→ 升级为协议：`submitNode` 带确定性幂等键 `${runId}:${nodeId}:${loopPath}:${attempt}`，
worker 先落 `waiting/poll` + `submit_key` 再打请求。

---

## 2. 顺带发现的一个既有静默 bug

**循环体内节点今天没有任何活性判定**（[engine.ts:1082](../src/lib/engine.ts) 无条件跑），
且 `ctx.nodes` 只在成功时写。

于是 foreach 遍历 3 个 vid、体内 `A=sql.query(onError=continue)` 在 i=1 超时失败时，
体内下游 B **照跑，读到的是 i=0 的 rows** —— 渲染出一条上一个 vid 的数据贴着 i=1 的标题，
`failCount` 记 1 但 `results` 里没有任何痕迹，**整条 run 全绿**。

改成「体内 ctx 只取同 loopPath 的行」后 B 会以 `MissingValue` 失败。方向是对的，
但这是**行为翻转**，必须登记进 divergence 表并配测试。

---

## 3. 全程红线

重构期间必须持续成立、会被写成测试的断言（节选，完整版见实施清单）：

- 全局 **fail-fast** 保留：任一节点 error 且 `onError='fail'` 时，拓扑序在其后的所有节点
  —— **包括与失败点毫无关系的并行分支** —— 一律 skipped。
  「只灭下游」是重构时最自然的写法，正因如此它是红线。
- `errButContinue` 是一等规则不是副产品。
- 活性是 **OR 不是 AND**；canceled 永不算活。
- `flow.merge` 的 `branches` 长度恒等于入边数，下标严格对应 edges 顺序，
  未跑到的填 `null`（不许用 `flatMap` 挤掉占位）。
- `foreach` 的 each 子树节点**任何情况下都不得在 `loopPath='{}'` 上产生第二次执行**。
- `fanout=0` 时 each 末端一次都不执行；done 子树照常执行（两个方向都要断言）。
- 体内 ctx 只取同 loopPath 的行。
- `ctx.nodes` 只写 success 的输出；error/skipped/canceled 永不进 ctx。
- `decide()` 对深冻结输入连调两次结果完全相同；**内部不读时钟**、不做 IO、不 await。
- `toRun` 与 `toSkip` 的 `(nodeId, loopPath)` 集合恒不相交，冲突时 toSkip 赢。
- `MAX_LOOP_ITERATIONS` 与 `OUTPUT_INLINE_LIMIT_BYTES` 全仓各只有一个出处（含 SQL、文档、Python）。
- golden fixture 全程离线可跑；任何 fixture 文件里不得出现明文凭证。
- `executeFlow` 任何路径下都不抛异常、不留 `status==='running'` 的僵尸记录。

---

## 4. 实施顺序

第一阶段**只到** engine-core 拆分 + `decide()` + golden 回放测试。
不含 worker、不含数据库落地、不含 SSE —— 那些建在这之上。
理由：这一阶段今天就能完整验证（证明新旧引擎在现有流程上逐步等价）。

全部 11 步已完成。**151/151 测试通过**，`npm run check:flows` 对同一批流程的输出
全程逐字节不变。

| # | 做了什么 | 落在哪 |
|---|---|---|
| 1 | ✅ 冻结不确定性：`runId`/`startedAtMs` 注入，`StepRun.seq` | `test/determinism.test.ts` 7 例 |
| 2 | ✅ `portOf` 收敛到一个出处 | `src/lib/flowGraph.ts`，8 例 |
| 3 | ✅ 开 IO 边界：`StepExecutor` 注入 | `executeFlow` 与 `executeSingleNode` 共用 |
| 4 | ✅ 删掉 `makeSeq` | 它是死代码：`mockOutput` 收作 `_seq` 从没用过 |
| 5 | ✅ golden 回放骨架 | `test/golden/harness.ts` |
| 6 | ✅ 19 条基线 + **反向验证** | `test/golden.test.ts` |
| 7 | ✅ 图函数提纯 | `src/lib/engine-core/graph.ts` |
| 8 | ✅ 词汇表与常量单一出处 | `engine-core/types.ts` + `npm run check:constants` |
| 9 | ✅ `decide()` 纯函数 | `engine-core/decide.ts`，19 条性质测试 |
| 10 | ✅ decideRunner 逐步等价 | `test/equivalence.test.ts` 11 例 |
| 11 | ✅ divergence 表 | `test/golden/divergence.ts` |

### 反向验证的结果

**一条都不红就说明覆盖是假的。** 两轮都做了，每次改完都还原：

| 故意改坏 | 变红 |
|---|---|
| `flow.merge` 的 `map` → `flatMap` | 1 条（下标占位被挤掉） |
| `truthy` 去掉 `'0'` 分支 | 1 条 |
| 全局 fail-fast 改成只灭下游 | 1 条 golden + 2 条 decide/等价 |
| foreach 超限改成截断 | 1 条 |
| `decide` 活性改成「非 skipped 就算活」 | 1 条（canceled 的下游被放行） |
| `decide` 去掉循环作用域 | 4 条（含"不许多发第 4 条"） |
| `decide` 去掉取消判定 | 3 条（含"取消反而多发一条"） |

### 第 10 步途中抓到的两处

**① 批量执行 `toRun` 会静默绕过 fail-fast。**
runner 最初一个 tick 把整个 `toRun` 跑完，于是 `bad` 和 `other` 同层时
`other` 已经跑完了 `bad` 才失败 —— "与失败点无关的分支也要停"这条红线被绕过去了。
批量执行等于偷偷引入并行。改成**一个 tick 只执行一个**，然后重新 decide。
并行是后面「架构优化」里一次显式的改动，不该从这里漏进来。

**② `flow.foreach` 置 success 的时刻变了**（已登记）。
旧引擎把它留到循环体跑完之后才写；新模型在展开出 `fanout` 的那一刻就置 success ——
因为 `decide()` 靠这一行上的 `fanout` 决定体内跑几次。语义上也更对：
循环节点的职责是"展开"，展开完它就完成了。内容逐字段相同，差的只是写入顺序。


---

## 5. 第二阶段：执行搬到服务端（已完成）

第一阶段证明了 `decide()` 与 `executeFlow` 逐步等价；这一阶段把它接到真的数据库和
worker 上。**「关掉浏览器流程照跑」从这里开始成立。**

### 建了什么

| 文件 | 作用 |
|---|---|
| `server/migrations/002_runs.sql` | `runs` / `steps` / `run_events` 三表 |
| `worker/store.ts` | 队列（`FOR UPDATE SKIP LOCKED`）、租约、心跳、reaper、步骤写入 |
| `worker/index.ts` | decide 驱动的执行循环 + deferred 唤醒 |
| `server/sql_service/runstore.py` | 入队、查询、取消（**执行不在这里**） |
| `src/lib/remoteRun.ts` | 前端：入队 + 增量拉取，折叠成已有的 `FlowRun` 形状 |

### 几个决定性的细节

**`scheduled_time` 是独立字段。** 日期基准、SLA、backfill、幂等键四件事全挂在它上面。
worker 用它当 `date()` 的基准而不是 `now()` —— 补跑昨天的日报时，
`date('now-1d')` 必须算出"相对那个计划时刻的昨天"。

**取消是 run 级事实。** `cancel_requested_at` 在 `runs` 上，`decide()` 通过
`run.status='canceling'` 看到它。只看 steps 的话，取消一条流程时下游的
`notify.wecom` 仍会被判为可跑 —— **取消反而多发一条消息**。

**`http-async` 不阻塞执行者。** submit 之后置 `waiting/poll` 交回队列，
由同一个 worker 循环按 `next_wake_at` 唤醒。**不需要单独的 triggerer 进程。**

**submit 之前先落 `submit_key`。** 那一刻还没有 handle，但必须已经有"我即将 submit"
的痕迹 —— 否则崩在 submit 返回之前，和"刚认领还没发请求"完全同形，
reaper 会重跑，平台上就多一个 Hive 大查询，而第一个没人持有也没人取消。

**`progress` 用 `||` 合并而不是覆盖**：`submit_key` 先落、`handle` 后到，
后一次写不能把前一次的痕迹抹掉。

### 验证

`test/worker.test.ts` 6 例，对真实 Postgres：

- 流程在服务端跑完，浏览器没有参与
- **崩溃恢复**：构造"第一步已成功、run 被回收"的库状态，新 worker 接着跑完，
  且第一步的输出原样保留 —— 已跑过的不重跑（重跑一个 `notify.wecom` 就是群里多一条）
- 失联太久判失败而不是永远停在 running
- 租约过期但还有重试机会时放回队列
- 取消：一个节点都不许跑，run 收尾成 canceled
- 事件 seq 连续无洞

浏览器实测：点「运行」→ `POST /api/flows/{id}/runs` → worker 执行 →
前端轮询显示，三个节点都带 `LIVE` 标记。

### 还没做的

- **SSE**：现在是按 `seq` 轮询。接口契约（增量拉取、断线带最后收到的 seq）已经定好，
  换成 SSE 不用动契约，只是省掉几次空请求。
- **重试**：`RetryPolicy` 仍是零实现（M5）。`failure_kind` 的列和分类已经就位。
- **大 output 外部化**：阈值定了 256KB，`putLarge` 还没写。
- `executeFlow` 仍然存在，作为没有数据库时的降级路径 —— 两者由等价性测试锁住。
