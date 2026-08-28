# 改进清单

> **本文件已被 [improvement-plan.md](./improvement-plan.md) 部分修订。**
> 经过对主流工作流引擎的机制调研（160 条机制、151 条采纳判断），本清单里有
> **六条决策被推翻**（engine 搬迁方式、慢查询轮询模型、misfire 默认值、CEL 优先级、
> OR-join 判定、自动停用），并新增了一整块缺失的设计（告警旁路）。
> 冲突处以 improvement-plan.md 为准，本文件保留为条目级 checklist。

设计依据见 [server-runtime-design.md](./server-runtime-design.md)。本文件是可勾选的执行清单。

标 ★ 的条目是**安全或数据正确性的关键项，不可跳过**。

## 依赖关系

```
M0 存储 ──▶ M1 服务端引擎 ──┬──▶ M2 调度器（定时终于会跑）
                            ├──▶ M3 Webhook
                            └──▶ M5 可靠性
                    M4 代码节点 ← 可与 M2/M3 并行
                    架构优化项 ← 无前置，随时可做
```

**M0 + M1 不可绕过。** Webhook、定时、代码节点都要求「服务端能持久化地跑流程」
先成立，否则请求进来了没人执行。

| 阶段 | 内容 | 交付后的变化 | 估算 |
|---|---|---|---|
| M0 | 存储与发布 | 流程存服务器，多人看到同一份 | 2-3 天 |
| M1 | 服务端引擎 | **关掉浏览器流程照跑** | 4-6 天 |
| M2 | 调度器 | **定时触发终于真的会跑**（现在是空的） | 1-2 天 |
| M3 | Webhook 触发器 | 上游系统能 POST 触发 | 2-3 天 |
| M4 | Python 代码节点 | 复杂数据加工不用在 SQL 里硬凑 | 3-4 天 |
| M5 | 重试 / 幂等 / 并发 | 慢 SQL 和网关抖动不再变成失败 | 2 天 |
| M6 | 部署交付 | 可以交给别人用 | 1-2 天 |

合计约 15-22 天。

---

## M0 · 存储与发布

> 参考：n8n 的 active/inactive 与 versionId；Temporal 的版本钉住

- [ ] 加 `postgres` 服务；选定迁移工具（Alembic，或裸 SQL 文件 + `schema_version` 表）
- [ ] 建表 `flows` / `flow_versions`（DDL 见设计文档 §2）
- [ ] ★ `flow_versions` 不可变：发布即新版本，绝不原地改
- [ ] API：`GET/POST /api/flows`、`GET/PUT /api/flows/{id}`、`DELETE`（归档而非物理删）
- [ ] API：`POST /api/flows/{id}/publish`（草稿 → 新版本 → 设 `active_version`）
- [ ] API：`GET /api/flows/{id}/versions`
- [ ] 服务端也跑一遍 `normalizeFlowDefinition`（[flowImport.ts](../src/lib/flowImport.ts)），不信任客户端提交的定义
- [ ] 前端 [library.ts](../src/lib/library.ts) 从 localStorage 换成 API；localStorage 保留为离线降级
- [ ] 工具栏加「发布」按钮 + 当前已发布版本号；草稿与已发布不一致时给出提示
- [ ] 首页「最近编辑」改读 `GET /api/flows`

---

## M1 · 服务端引擎（核心）

> 参考：Temporal 的事件溯源；Windmill 的「Postgres 当队列」

### 引擎拆分

- [ ] `engine.ts` 拆成 `engine-core`（纯逻辑）/ `mockHost`（浏览器）/ `liveHost`（worker）
- [ ] 抽掉两处浏览器依赖：`window.setTimeout`（engine.ts:468）、`TextEncoder`（engine.ts:441）
- [ ] `engine-core` 建成 workspace 包，前端与 worker 共同引用
- [ ] ★ 表达式解析与 `validateNode` 只此一份实现 —— 不写 Python 版本
- [ ] 现有 `test/` 用例迁到 `engine-core` 下跑通

### 运行持久化

- [ ] 建表 `runs` / `run_events`（含 partial unique index 与队列索引）
- [ ] 定义事件类型表（`run.started` / `node.succeeded` / `node.progress` …，见 §2.1）
- [ ] `record()` 改成 `appendEvent()`；run 状态由事件 fold 得出，不再是可变对象
- [ ] fold 函数前后端共用：产出的仍是现有 `FlowRun` 形状，UI 组件不改
- [ ] 大 output 外部化：> 256KB 转存，事件里只留 `$ref`（对应 `x-large`）

### Worker

- [ ] Node worker 进程骨架
- [ ] 队列认领：`FOR UPDATE SKIP LOCKED` + 60s 租约
- [ ] 20s 心跳续租；reaper 回收过期租约（`attempt < 3` 回 queued，否则置 error）
- [ ] 崩溃恢复：fold 事件 → 从未完成节点续跑
- [ ] ★ `http-async` 节点恢复时 **re-attach `node.progress` 里的 handle**，绝不重新 submit
      —— 重新 submit 会在数据平台上多跑一个 Hive 大查询且无人取消
- [ ] 中止：`POST /api/runs/{id}/cancel` → worker 调 `cancelNode` 撤掉平台任务

### API 与前端

- [ ] `POST /api/flows/{id}/runs`、`GET /api/runs`（分页）、`GET /api/runs/{id}`
- [ ] SSE：`GET /api/runs/{id}/events?fromSeq=N`，断线可续订
- [ ] 前端 [store.ts](../src/store.ts) 的 `startRun` 改为 `POST` + `EventSource`
- [ ] 浏览器 mock 引擎保留，用途改为离线预览与编辑期表达式预览
- [ ] 运行历史页：按流程筛选、状态筛选、点进去看完整事件

---

## M2 · 调度器

- [ ] 建表 `schedules`
- [ ] ★ 四种模式（daily/hourly/interval/cron）在**存储层归一成 cron**，UI 保留友好配置
- [ ] 调度循环跑在 worker 内，用 Postgres advisory lock 保证多 worker 时只有一个在调度
- [ ] ★ 时区存 IANA 名（`Asia/Shanghai`），不存 UTC 偏移；UI 上显示出来
- [ ] ★ misfire 策略默认 `skip`（只跑最近一次）—— 服务停 3 小时后补跑 6 次日报会刷屏
- [ ] 发布时把 `trigger.schedule` 节点参数同步进 `schedules` 表
- [ ] 停用/启用开关；UI 显示「下次触发时间」

---

## M3 · Webhook 触发器

> 参考：n8n 的 test webhook 与 responseMode

### 节点与入口

- [ ] [registry.ts](../src/registry.ts) 加 `trigger.webhook`
- [ ] ★ [manifest.py](../server/sql_service/manifest.py) 同步加，两边字段必须一致
- [ ] 建表 `webhooks` / `webhook_deliveries`
- [ ] `POST /hooks/{token}` 入口（不在 `/api` 下，认证方式不同）

### 入参映射

- [ ] 通道一：body 顶层按 `flowInputs` 同名取 → `$.trigger.*`
- [ ] 通道二：原始 body 全量 → `$.nodes.<id>.output.body`
- [ ] 类型转换与校验复用 `engine-core`（`"7"` → `7`；`"abc"` → 400 并指明字段）
- [ ] 错误报文面向上游开发者：`{error, detail, field}`

### 安全

- [ ] 路径 token：32 字节随机，不可枚举
- [ ] ★ 认证 `secret`：`X-Webhook-Secret` 头，`compare_digest` 常数时间比较
- [ ] 认证 `hmac`：签名对 **raw body**（不是 parse 后重新序列化的），带 `X-Timestamp`，偏差 > 5 分钟拒绝
- [ ] ★ 限流四层：body 1MB（按 `Content-Length` 提前拒）、60 次/分、单流程并发 run = 1、队列深度 10
- [ ] ★ Webhook 触发一律 `mode='production'` → **忽略 pinData**（[types.ts](../src/types.ts) 已定义此语义）
- [ ] 只触发 `active_version`；未发布 → 409；`enabled=false` → 404（不是 403，不泄露 token 存在）
- [ ] 幂等：`Idempotency-Key` 头，同 key 24h 内返回同一 runId
- [ ] token / secret 一键轮换（token 挂在 flow 上不挂在 version 上，改流程不用让上游改配置）
- [ ] ★ `webhook_deliveries` 只存 `body_bytes` + `body_digest`，**不存 body 原文**；nginx access log 保持不记 body

### 响应

- [ ] `immediate`（默认）：`202` + `{runId, status, statusUrl}`
- [x] `lastNode`：默认等待 300s，可配置 1–1800s；超时返回 202 + runId，流程继续跑完
- [ ] UI 上对含 SQL 节点的流程警告不要用同步模式

### 前端

- [ ] 完整 URL + 一键复制
- [ ] 按当前 `flowInputs` 自动生成 curl 示例，入参一改示例跟着变
- [ ] ★「监听一次」测试模式：60s 窗口抓真实请求 → 显示 body → 一键存 pinData
- [ ] 最近投递记录：时间 / 来源 IP / 状态码 / 耗时 / runId

---

## M4 · Python 代码节点 ✅（2026-08-28 落地；四处改判见 server-runtime-design §10 头部的修订记）

> 参考：Dify 的输入变量映射 + dify-sandbox；Windmill 的 nsjail

### 安全边界（先做这一组，再做功能）

- [x] ★★ `code` 字段**绝不做模板插值** —— 否则 webhook body 可直接注入 Python 代码，是真实的 RCE
- [x] 用 schema 标记 `x-no-template` 声明，引擎照标记跳过，**不在引擎里硬编码字段名**
- [x] ★★ 防回归测试：`code` 里写 `{{ $.trigger.x }}` 必须原样进入沙箱，不被替换（test/codePython.test.ts）
- [x] 独立 `sandbox` 容器 —— **已落地（nsjail 未上，容器边界先行）**：无凭证、
      独立网络（解析不到 postgres）、mem/pids/cpus 限额，api 经 `SANDBOX_URL`
      转发执行与装包（deploy/sandbox.Dockerfile + sandbox/service.py）。
      本地开发保留子进程模式（显式双闸）；两边都没配默认拒绝执行
- [x] ★★ 环境变量完全清空：专项测试（server/test_code_python.py 的 canary 用例）
- [x] ~~`--network=none`~~ **改判：联网放开**（用户决策；代价与兜底见 §10 修订记和 README）
- [ ] 只读 rootfs / setuid 分离 / 系统调用过滤 —— 属于 nsjail 那一步；容器已有
      非 root（uid 65534）+ compose 限额（mem 1g / pids 128 / cpus 2），
      本地模式尽力 rlimit（macOS 实情在 code_runner.py 注释里）
- [x] 墙钟超时默认 30s / 上限 120s，到点 SIGKILL（killpg 连坐用户 fork 的子孙）
- [x] 输出大小上限 10MB；代码长度上限 ~~64KB~~ **改判：1MB**
- [x] 预装包锁版本，不支持用户装包 —— **改判升级：清单进库（sandbox_packages 表）+
      管理员「Python 依赖」页增删 + venv 对账**；种子加了 `requests`（联网放开的配套）

### 执行契约

- [x] 入口固定 `def main(inputs: dict) -> dict`；缺函数 → 保存期报错（vars.ts）
- [x] ★ 结果走独立 pipe fd（pass_fds），**不解析 stdout** —— 用户 `print()` 一下不能搞坏结果
- [x] stdout / stderr 收集成 `logs` 输出字段（`x-output-ui: {group:'run'}`）
- [x] 返回值非 dict / 不可序列化 → 明确报错点名键路径；`datetime` 自动转 ISO 且 logs 里说明；
      numpy 标量鸭子转换（pandas to_dict 吐的 np.int64 不该和"必须可序列化"打架）
- [x] 错误信息带**用户代码的行号**，剥掉沙箱包装层栈帧
- [x] 错误分类：语法错/异常/返回值非法 → 不可重试；沙箱不可用/疑似 OOM → 可重试（错误码两侧对齐）
- [x] `runtime.kind: 'http'`（同步）；`policy.idempotent: true`。
      `dryRunnable` 没写 —— 全仓零消费者，声明了没人读的注解比没有更糟

### 节点与前端

- [x] [registry.ts](../src/registry.ts) + [manifest.py](../server/sql_service/manifest.py) 加 `code.python`
- [x] 「输入变量」kv 映射 UI，值用现成的 [RefField](../src/components/RefField.tsx)（kv 控件本来就是）
- [x] 输出结构复用 `x-dynamic: 'run'` + `probedOutput`（toCodeFields：顶层 spread，排除保留键）
- [x] CodeMirror 6 + Python 高亮 + Tab 缩进（CodeEditor.tsx；code 字段按 x-no-template 分派，屏蔽 {{}} 胶囊）
- [x] 新建节点给默认骨架而非空白（schema default，store.defaultParams 自动拷）
- [x] 「试运行」复用 `executeSingleNode`，跑完写回 `probedOutput`
- [x] 输出面板分「返回值」（结构化）与「日志」（等宽）两块（NDV 既有机制：多行字符串自动折成等宽块）

---


## M5 · 重试 / 幂等 / 并发

- [ ] `RetryPolicy` 补齐四要素：`initialMs` / `backoffCoefficient` / `maximumIntervalMs` / `nonRetryable`
- [ ] 引擎实现重试循环（现在 [types.ts](../src/types.ts) 定义了、[registry.ts](../src/registry.ts) 声明了，**一行实现都没有**）
- [ ] `node.failed` 事件带 `willRetry` / `nextAttemptAt`，UI 显示「第 2 次重试中」
- [ ] ★ 错误分类：4xx（除 429）不重试，429/5xx/网络/超时 才重试 —— SQL 语法错重试 3 次纯属浪费
- [ ] ★ 幂等键 `sha256(runId + nodeId + iteration)` 随请求头下发给节点服务
- [ ] ★ `notify.wecom` 服务端幂等表（24h）—— 否则重试和崩溃恢复都会让群里收到重复日报
- [ ] 三层并发上限：worker 全局 4、单流程 1、`flow.foreach` 串行
- [ ] `flow.foreach` 去掉 `items.slice(0, 3)` 硬编码，放开嵌套循环
- [ ] `onError` 增加错误输出口（n8n error output），失败数据流向补偿分支

---

## M6 · 部署交付

- [ ] `docker-compose.yml`：`postgres` / `api` / `worker` / `sandbox` / `nginx`
- [x] nginx：静态站点 + `/api/` + `/hooks/`（`client_max_body_size 1m`、`proxy_read_timeout 1810s`）+ SPA 回退
- [ ] 生产环境 `CORS_ORIGINS` 留空（同源反代后不需要，代码已支持）
- [ ] ★ 凭证走 `env_file` 挂载，**绝不 COPY 进镜像**
- [ ] HTTPS（Webhook 带密钥，内网也要上 TLS）
- [ ] `pg_dump` 每日备份 —— 运行记录可以丢，流程定义不能
- [ ] `run_events` 90 天保留策略（删事件明细，保留 `runs` 主记录）
- [ ] 各服务健康检查 + `restart: unless-stopped`
- [ ] 首次部署文档（补进 README）

---

## 架构优化（无前置，可随时并行）

> 这些是「市面上成熟设计」里还没落地的部分

- [ ] ★ 表达式换 **CEL**（前后端各有成熟实现，可静态类型检查，沙箱安全）
      —— [engine.ts](../src/lib/engine.ts) 的 `resolveExpr` 现在是手写迷你解析器，
      **越晚换越贵**：等用户流程里存了几百个手写表达式就换不动了
- [ ] 拓扑同层节点并行执行 + `maxConcurrency`（现在 `for...await` 严格串行，三个独立 SQL 串行跑 3 分钟）
- [ ] 凭证层（n8n Credentials）：凭证与流程定义分离存储，流程里只存 `credentialId`；
      `notify.wecom` 的 webhook 地址、`http.request` 的 token 都该走它
- [ ] 子流程节点 `flow.call`（n8n Execute Workflow / Dify workflow-as-tool）
- [ ] 等待 / 人工审批节点（Temporal Signal / Camunda User Task）—— 依赖 M1 的持久化
- [ ] 写一条决策记录：**数据模型守住 variable pool，不引入 n8n 的隐式 item fan-out**

---

## 明确不做

写下来是为了以后不用重新讨论：

- **不引 K8s / Redis / RabbitMQ / Temporal** —— 内部工具，个位数并发，Postgres + SKIP LOCKED 够用，少三个要运维的组件
- **代码节点不联网、不支持装包** —— 要调接口走 `http.request`（URL 可审计），要装包是另一个需求（牵扯镜像构建与供应链审查）
- **不做 item-based 隐式 fan-out** —— 你的数据是「一个结果集」不是「一批 item」，混进来会让 `flow.merge` 的下标语义失控
- **不用 Python 重写引擎** —— 表达式和校验前端也要跑，双实现必然漂移，且两边单独测都是对的，极难排查
