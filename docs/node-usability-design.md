# 对标 n8n / Activepieces / Dify：降低使用成本与提高节点可用性

本文件回答一个问题：**三个成熟的工作流产品已经验证有效、而本仓库既没做也没进任何计划的，还剩什么。**

它和已有文档的关系：

| 文档 | 管什么 | 本文件与它 |
|---|---|---|
| [improvement-plan.md](./improvement-plan.md) | 引擎机制（160 条调研，M0–M6） | 不重复；3.11 / 3.17 / 3.18 是它 M5 的产品侧展开 |
| [visual-data-reference-design.md](./visual-data-reference-design.md) | 取值面板 / 胶囊 | 不重复；3.4 / 3.12 在它之上加模式 |
| `.hermes/plans/2026-08-22_*.md` 三份 | 交互层改造（首页、顶栏、Inspector、取值面板聚合） | 不重复；引用时写它们的任务编号（`M1` / `H2` / `T0-6` …） |

产出依据：三路代码审计（节点契约与表单 / 运行·调试·取值链路 / 三份计划的落地状态）+ 一路对抗性评审
（逐条对照代码核可行性，推翻了初稿 8 处，见 §9）。每一条都给**代码出处**，没有出处的不写。

---

## 0. 一句话结论

n8n、Activepieces、Dify 在「使用成本」上真正省的不是画布，而是**四件事**：
凭证不用反复粘、失败有人告诉你、跑挂了不用从头来、取数据不用写路径。

本仓库第四件已在做（胶囊 + 取值面板），**前三件全部缺席** —— 而其中两件后端已经把路修好了，只差产品入口：

- 失败告警：`flows.notify_config` 这一列 worker 会读（[alerts.ts:45](../worker/alerts.ts)），投递、抑制、重试全在，
  但**没有任何接口或界面能写它**，`recordRunAlert` 永远在第 45 行 early return
- 重跑：`steps` 表按节点物化、worker 每步 `decide()` 从库重算、`POST /api/flows/{id}/runs` 收 `version` ——
  前端 [client.ts:491](../src/lib/client.ts) 从不传它，`runstore.py:55` 注释里写着的 redrive 在产品里不可达

---

## 1. 成本模型：五种成本，三家各自怎么省

「使用成本」拆成五段来看，每一段三家各有一个被反复验证的解法：

| 成本 | n8n | Activepieces | Dify | 本仓库现状 |
|---|---|---|---|---|
| **学**（第一次） | 节点内 Docs 链接、示例、notice | Piece 描述 + Markdown 说明属性 | 节点说明 + Help | 有字段 `description`（[SchemaForm.tsx:122](../src/components/SchemaForm.tsx)）；无文档链接、无搜索别名（[NodePicker.tsx:96-98](../src/components/NodePicker.tsx) 只匹配 name / type / description） |
| **配**（每个节点） | Credentials 复用；loadOptions 依赖联动 | Connections；动态下拉 + refreshers | 环境变量（secret）；字段说明 | **无凭证层**：企微 webhook / HTTP token 明文进 `flow_versions.definition`（[registry.ts:721](../src/registry.ts)，连 `secret` 都没标）；动态下拉只有 `sql.engines` 一个键、启动预取、丢 label（[client.ts:134](../src/lib/client.ts)）、无联动 |
| **取**（引用上游） | 拖字段生成表达式；Schema 视图 | 数据选择树 | 变量选择器 | 取值面板 + 胶囊已做；**不能拖**（全仓库无 `onDrop`）；过滤器缺 `where` / `limit` / `avg`（[output.ts:17-26](../src/lib/output.ts)） |
| **调**（跑通） | pin、Execute step、**Retry from failed**、Debug in editor | Test step、**Retry from failed step**、Test trigger（监听） | Run this step、变量检视 | pin / 试运行有；**无重跑、无从失败处续跑**；Webhook 无「监听一次」 |
| **运**（每天） | Error workflow；Retry on fail；Settings tab | Retry / Continue on failure；**Issues** | 重试 + 失败分支；定时 / 版本 | 告警旁路后端全套但无入口；重试不可配且 manifest 与 worker 不一致（[manifest.py:139](../server/sql_service/manifest.py) 说 2 次，[errorCodes.ts:78](../src/lib/engine-core/errorCodes.ts) 写死 3 次）；无失败出口；无节点备注 / 暂停 |

---

## 2. 缺口总表（按 痛点 ÷ 成本 排序）

| # | 缺口 | 对标 | 现状出处 | 成本 | 批次 |
|---|---|---|---|---|---|
| 1 | 失败通知没有入口 | n8n Error Workflow / AP Notifications | `004_webhooks.sql:80` 有列；`alerts.ts:45` 读；无 API / UI 写 | XS | 1 |
| 2 | 定时触发不显示「下次几点跑」 | AP cron 描述 / 通用 | [cron.ts:141](../src/lib/engine-core/cron.ts) `nextFireTimes` 零调用者；时区单值且折在高级里（`registry.ts:61-68`） | XS | 1 |
| 3 | 节点无备注 / 暂停 / 重试覆盖；`policy.retry` 没人读 | n8n Settings tab / Dify 节点描述 / AP Skip step | [types.ts:193-201](../src/types.ts) 只有 `onError`；[worker/index.ts:290](../worker/index.ts) 读写死的 `DEFAULT_RETRY` | S | 1 |
| 4 | 表达式缺行筛选、前 N、均值 / 极值、取整 | n8n Filter / Limit / Summarize；Dify List Operator | `FILTERS` 16 个，`find` 只返回一行（[selectionFilters.ts:63](../src/lib/selectionFilters.ts)） | S | 1 |
| 5 | 流程入参只有 3 种类型、无默认值、不记上次 | Dify Start 节点 / n8n Form / AP 记住测试数据 | `FlowInputField`（`types.ts:204-209`）；`manualInputs` 仅会话态（`store.ts:333`） | S | 1 |
| 6 | 循环节点三个「假开关」 | — | [registry.ts:356-358](../src/registry.ts) 声明 `concurrency / batchSize / continueOnItemError`，引擎与 worker 零引用；worker 写死 `failCount: 0`（`index.ts:341`） | XS 先删 / L 实现 | 1 / 3 |
| 7 | 节点可发现性：无搜索别名、无文档链接 | n8n codex alias / AP piece docs | `NodeType`（`types.ts:168-190`）无 `keywords` / `docsUrl` | XS | 1 |
| 8 | 快捷键无帮助面板 | n8n `?` / AP | 13 组快捷键散在 4 个文件，无 cheatsheet | XS | 1 |
| 9 | 前后端节点定义无一致性测试 | — | `registry.ts` 与 `manifest.py` 已在 `description` / `policy` / `runtime` 上漂移；HTTP manifest 缺 `group:'advanced'` | XS | 1 |
| 10 | **连接（凭证）层** | n8n Credentials / AP Connections / Dify Secret env | 无任何凭证实体、表、接口 | M | 2 |
| 11 | 重跑：同入参再跑、从失败节点续跑 | n8n Retry execution / AP Retry from failed step | 前端不可达；`steps` 表 + `decide()` 已具备条件 | M | 2 |
| 12 | 拖字段到输入框 | n8n 拖拽映射 | 无 `onDrop`；粘贴已能胶囊化（[RefField.tsx:464](../src/components/RefField.tsx)），缺的只是 drop | S | 2 |
| 13 | Webhook「监听一次」 | n8n Listen for test event / AP Test trigger | `WebhookPanel.tsx` 有最近投递，无捕获样例 | M | 2 |
| 14 | 首页「需要处理」（上次失败红点） | AP Issues | 列表 API 无 last run（hermes H2 PARTIAL 的根因） | S | 2 |
| 15 | 智能粘贴：cURL → HTTP 节点；节点跨流程复制 | n8n paste cURL / 系统剪贴板 JSON | `copyNodes` 仅内存（`store.ts:449`）；cURL 只在 HTTP 表单内 | S | 2 |
| 16 | NDV 导出 CSV / 复制 JSON | n8n Download | `NodeDetailView.tsx` 只能复制表达式 | XS | 2 |
| 17 | 失败出口（error port） | n8n error output / Dify fail branch | [roadmap.md:205](./roadmap.md) 未做；`NodePort` 无语义 | M | 3 |
| 18 | 循环收集结果 + 真正的并发 / 容错 | Dify Iteration 并行 + 错误模式 / ASL Map | improvement-plan M5；输出无 `collected` | L | 3 |
| 19 | 动态下拉联动（dependsOn）+ 懒加载 + label | AP refreshers / n8n loadOptionsDependsOn | [SchemaForm.tsx:145](../src/components/SchemaForm.tsx) 预取单键 | S（契约） | 3（需平台接口） |

---

## 3. 设计

每条的格式：现状 → 设计 → 验收。带 ★ 的是结构性改动。

### 3.1 失败通知入口（#1）

**现状**：`flows.notify_config JSONB` 由 worker 读（[alerts.ts:32,45,62](../worker/alerts.ts)），投递、600 秒抑制窗口、3 次重试全在；
没有任何地方写它。流程设置面板（[Inspector.tsx:237-273](../src/components/Inspector.tsx) `FlowInspector`）只有名称和入参。

**设计**（n8n Error Workflow 的最小形态）：

- 流程设置新增一节「失败时通知」：企微 webhook（3.10 落地后改为连接下拉）+ 开关。
  文案说清「整条运行失败才发；同一原因 10 分钟内只发一条」—— 抑制是告警能活下来的前提，不说清用户会以为丢了
- API **不走 `PUT /api/flows/{id}`**：那是编辑器每几秒一次的草稿自动保存通道（[main.py:358-366](../server/sql_service/main.py)，body 只有 `definition`，
  且刻意不记审计 [flowstore.py:253-257](../server/sql_service/flowstore.py)）。把运维配置挂上去，要么得做 PATCH 语义（缺字段 ≠ 清空），
  要么每次自动保存都会覆盖它。照 webhook 子资源的样子（`main.py:703-760`）加 `GET/PUT /api/flows/{id}/notify`：
  `_guard(get_flow)` → `flowstore.set_notify_config()`（`UPDATE flows SET notify_config` + `_audit('flow.notify')`）。
  `get_flow` 的 SELECT 和 `_summary`（`flowstore.py:111-131, 199-206`）补这一列。它不是定义的一部分，不进版本
- 前端：`SavedFlow` 加 `notifyConfig`、`client.ts` 两个调用、store 一个 setter；本地模式不显示这一节（没有 worker 就没有告警）
- 告警里的链接：[alerts.ts:104](../worker/alerts.ts) 现在给的是 `/api/runs/{id}`，一个 JSON 接口 —— 而前端没有任何能打开某次运行的 URL
  （[appRoute.ts](../src/lib/appRoute.ts) 只认 `/` 和 `/workflows/:id`，运行记录是首页弹窗）。三件小事：
  `deploy/env.example` 与 compose 的 worker 加 `PUBLIC_APP_URL`；`appRoute.ts` / `Home.tsx` 认 `/?run=<id>` 直接打开那条运行记录；然后才改告警文案。
  没配 `PUBLIC_APP_URL` 时保持现状
- 3.10 接入后：[alerts.ts:108-112](../worker/alerts.ts) 调企微执行接口时**没带委托头**（`X-Worker-Token` / `X-Run-Creator`），
  `conn:` 解析会 403。同一条查询里已经有 `owner`（`:31-40`），带上即可

**验收**：配好后故意写坏 SQL 定时跑一次 → 群里收到「【流程失败】…」；10 分钟内第二次失败 → `alerts.status = 'suppressed'`；点链接打开运行记录。

### 3.2 定时触发「下次运行」（#2）

**现状**：`nextFireTimes(cron, tz, after, n = 5)` 在 [cron.ts:141](../src/lib/engine-core/cron.ts)，注释写着「UI 上『下次几点跑』直接用它」，零调用。
用户看到的是「每天 09:00」，看不到「明天 09:00 真的会跑」。

**设计**：

- [types.ts:36](../src/types.ts) 的 `preview: 'date'` 扩成 `'date' | 'schedule'`；`trigger.schedule` 根 schema 挂 `x-ui.preview: 'schedule'`
  （registry 独占节点，不会被后端 manifest 覆盖）
- [schedule.ts](../src/lib/schedule.ts) 加 `nextRunTexts(params, after, n = 3)`：`toCron(params)`（会 throw，要 catch）→ `nextFireTimes` → 文案。
  组件不直接 import engine-core —— 现在没有任何组件这么做，`schedule.ts` 就是 UI 侧的包装层
- 新建 `SchedulePreview.tsx`（照 [DatePreview.tsx](../src/components/DatePreview.tsx)）：「**发布后**将按：明天 09:00 · 周一 09:00 · 周二 09:00（北京时间）」。
  措辞必须是「发布后」—— 调度器跑的是已发布版本，眼前是草稿。调度器没心跳时用现有 `SCHEDULER_OFF_SHORT` 替换；
  `interval` 模式注明「按整点对齐」（`toCron` 注释里写明的有损转换）
- 首页卡片的「下次」**不能从草稿 def 算**：真相在 `schedules.next_fire_at`（含 misfire / 重叠之后的实际值），
  而且列表里未缓存的流程只是一个没有 `trigger` 的壳（[library.ts:166-170](../src/lib/library.ts)）。
  `GET /api/flows` LEFT JOIN `schedules` 回传 `nextFireAt`，`SavedFlow.nextFireAt`，卡片显示「下次 明天 09:00」
- 时区：保持单值，但从高级里拿出来显示在预览行尾 —— 折叠一个改不了的下拉没有意义

**验收**：`test/schedule.test.ts` 固定 `after` 断言三次触发时刻；cron 翻不动（`describeCron` 原样回显）时预览仍能算 —— 算的是确定性时刻，不是翻译。

### 3.3 节点设置标准区 + 重试单一来源（#3）

**现状**：每个节点实例只有 `onError`（[types.ts:198](../src/types.ts)），Inspector 只画它（[Inspector.tsx:201-214](../src/components/Inspector.tsx)）。
worker 的重试用 `DEFAULT_RETRY[typeId]`（[errorCodes.ts:77-81](../src/lib/engine-core/errorCodes.ts)），manifest 的 `policy.retry` 没有任何消费者，
两边数字还不一样（`sql.query` 2 vs 3）。

**设计**（n8n Settings tab 的子集 + Dify 节点描述）：

```ts
// FlowNodeData / FlowDefinition.nodes[]
note?: string                         // 备注，卡片下一行灰字（Dify「描述」/ n8n notesInFlow）
disabled?: boolean                    // 暂停：跳过不执行（AP Skip step / n8n Deactivate）
retry?: Partial<RetryPolicy> | null   // null = 不重试；缺省 = 按节点类型 policy.retry
```

- Inspector「设置」一节（`details`，接在错误处理后）：失败时 / 重试（默认 · 按类型 N 次 / 不重试 / 自定义）/ 备注 / 暂停。
  右键菜单与悬停工具条加「暂停 / 恢复」。**控制与触发节点不给暂停开关**（`flow.if` / `flow.foreach` / `flow.merge` / `hasInput === false`）——
  [decide.ts:136-155](../src/lib/engine-core/decide.ts) 要读它们的 `matched` / `fanout`，没有这行下游永远 stuck
- **暂停 = 对活性透明的 pass-through**。这是评审改掉的第一处：现在 [decide.ts:210-224](../src/lib/engine-core/decide.ts) 只认 `success` 或
  `failed + continue` 的上游为「活」，`skipped` 上游会让整条下游 `unreachable`。照原样做，「暂停企微节点调 SQL」成立，
  但「暂停中间一个 HTTP 节点看后面会怎样」会把后面全灭掉 —— 而 n8n Deactivate / AP Skip 都是 pass-through 语义。
  改法：`skipped{kind:'disabled'}` 的源视作「该节点本来活它就活」（链式递归），`decide.ts` 与浏览器引擎 [engine.ts:988-997](../src/lib/engine.ts)
  **两边同改**，`test/equivalence.test.ts` + `test/golden.test.ts` 加用例 —— 等价性测试是证明两个引擎一致的唯一手段。
  `SkipReason`（[engine-core/types.ts:59-65](../src/lib/engine-core/types.ts)）加 `disabled`，[RunHistory.tsx:44-51](../src/components/RunHistory.tsx) 的 `SKIP_TEXT` 补文案；
  浏览器 `StepRun` 没有 `skipReason`（`types.ts:249-279`），补上并在 `engine.ts:906-912` 写入，否则本地模式只显示一个「跳过」
- 下游**引用**暂停节点的值 → 报错「节点「X」已暂停，没有输出」。不给空值 —— 和 README「引用取不到值 = 报错」是同一条约定
- 校验放行：Toolbar / RunPanel 用每个非 pinned 节点的 `validateNode` 拦运行（[Toolbar.tsx:95-107](../src/components/Toolbar.tsx)、
  [RunPanel.tsx:114-119](../src/components/RunPanel.tsx)、[check-flows.ts:40-44](../scripts/check-flows.ts)）——
  一个暂停的企微节点缺 webhook 仍会拦住「调 SQL」，而这正是暂停的用途。照 pinned 的例子把 `disabled` 一并豁免
- 持久化白名单有三处，漏一处就静默丢字段：[flowImport.ts:39-47](../src/lib/flowImport.ts) `normalizeFlowDefinition` 按显式键重建节点、
  [store.ts:1174-1182](../src/store.ts) `toDefinition`、`store.ts:1206-1223` `loadDefinition`。三处都加，并写一条 normalize → load → toDefinition 的往返测试。
  [flowdef.py:77-91](../server/sql_service/flowdef.py) 不拒绝未知键，只需为三个新字段补类型检查
- 「改没改」判定：[flowstore.py:134-140](../server/sql_service/flowstore.py) `_differs` 只剥顶层 `layout / version`。
  决定：**`note` 不算逻辑改动**（和拖位置同类），在 `logic()` 里按节点剥掉；**`disabled` 算**（它改变行为）。
  不做这个判断的后果是改一个备注 → 「草稿未发布」→ 发布生成新版本 → 每次手动运行多一份负版本快照
- 重试收成一处，但形状要先对齐：worker 的 `backoffMs()` 吃 `RetrySpec{maxAttempts, initialMs, backoffCoefficient, maximumIntervalMs}`
  （`errorCodes.ts:70-85`），而 `RetryPolicy` 是 `{maxAttempts, backoff: 'fixed' | 'exponential', initialMs}`（`types.ts:139-143`），
  后者喂不进前者。把 `RetryPolicy` 扩成前者（`backoff` 映射成系数 1 / 2），`spec = {...t.policy.retry, ...node.retry}`；
  删掉 `DEFAULT_RETRY`，**四个 live 节点的 manifest 都显式声明 `policy.retry`**（现在只有 `sql.query` 有；`postgres.workspace` 根本不在 `DEFAULT_RETRY` 里，从不重试）。
  `isRetryable(code)` 仍然把关 —— UI 文案要写「仅基础设施类错误重试（平台抖动、限流、超时）」，否则用户会以为 SQL 语法错也会重试三次
- **HTTP 节点已经有两层重试**：节点内 `retryEnabled / maxRetries / retryIntervalMs`（[http_request.py:381-409](../server/sql_service/http_request.py)，执行接口内 500 ms 级快重试）
  + worker 的 `DEFAULT_RETRY['http.request']` 3 次 —— 今天最多 3 × (1 + maxRetries) 次请求，对非幂等的 POST 尤其危险。
  统一成一层：节点级 `retry` 是唯一入口，`http.request` 的 `policy.retry` 不声明（worker 不再二次重试），
  执行时把节点级 `retry` 映射到现有的节点内参数，并从表单隐藏那三个字段
- 卡片：暂停态整体 40% 透明 + 「已暂停」角标；备注一行省略

**验收**：暂停企微节点 → 运行 → 该步 `skipped(disabled)`，上游照跑；暂停中间的 HTTP 节点 → 下游照跑、引用它的字段报错；golden / equivalence 各加用例。

### 3.4 过滤器补齐：筛选行 / 前 N / 均值极值 / 取整（#4）

**现状**：`FILTERS`（[output.ts:17-26](../src/lib/output.ts)）16 个，无行筛选（`find` 只取第一个匹配，[selectionFilters.ts:63](../src/lib/selectionFilters.ts)）、
无 `limit`、无 `min / max / avg`、无数字格式化。日报里「只发 dc > 5 的」「前 10 名」「平均卡顿率 12.3%」三句话今天表达不出来，
只能回去改 SQL —— 而改 SQL 意味着再跑一次几分钟的 Hive。

**设计**（Dify List Operator 的 filter / order / limit + n8n Summarize 的子集；仍然编译成现有管道，不换引擎）：

| 过滤器 | 签名 | 语义 |
|---|---|---|
| `where` | `where(col, op, value)` | 保留所有匹配行；op 复用 `find` 的 `eq / neq / contains / gt / lt`（`selectionFilters.ts:53-61`），加 `gte / lte` |
| `limit` | `limit(n)` | 前 n 行。`sort(dc, desc) \| limit(10)` = 前十名 —— 比为此拖一个「列表处理」节点近得多 |
| `min` / `max` / `avg` | `(col?)` | 与 `sum` 同形（[engine.ts:239-249](../src/lib/engine.ts)）。**空集返回 `undefined`**，和 `find` 未命中一致（`selectionFilters.ts:77`），这样 `\| default('—')` 能兜住 |
| `round` | `round(digits = 0)` | 数字取整；非数字报错 |
| `percent` | `percent(digits = 1)` | `0.123 → 12.3%`，结果是字符串（`referenceFit` 要认） |

为什么空集不能抛错：`default` 只接住 head 的 `MissingValue` / `undefined`，`applyFilter` 里抛的错会直接穿出去（`engine.ts:324-345`）——
一个抛错的 `avg` 是没法 `default` 的。

- 取值面板在 hermes 计划 M2「汇总」模式之上追加，**不另开页签**：「按条件」模式加「保留全部匹配行」开关 → `mode: 'where'`；
  汇总区加 平均 / 最大 / 最小；「前 N 行」输入框 → `mode: 'top'`（编译成 `sort | limit`）
- 要同步的枚举点（漏一处就是「面板能选、校验不认」或反过来）：`FILTERS`（`vars.ts:338-343` 读它）、`applySelectionFilter` 白名单
  （`selectionFilters.ts:32`，`where` 放这里）、`FILTER_LABEL`（[refLabel.ts:120-132](../src/lib/refLabel.ts)，**现在连 `sum / unique / join / sort / default` 都缺**，一起补）、
  `ReferenceSelection` 联合类型 + `compileReferenceSelection`（[referenceSelection.ts:5-22, 48-71](../src/lib/referenceSelection.ts)）、
  面板模式条（[DataReferenceDrawer.tsx:347, 363](../src/components/DataReferenceDrawer.tsx)）、[referenceFit.ts:9-14](../src/lib/referenceFit.ts)、
  [MessagePreview.tsx:71](../src/components/MessagePreview.tsx) 的列名提示正则（只认 `table | list | lines`）、README 的过滤器表
- 没有 Python 侧对拍要担心：worker 直接 import `engine.ts` 的 `resolveTemplate`（[worker/index.ts:6](../worker/index.ts)），
  服务端只渲染 SQL 占位符且明确排除 `$.`（[sqlparams.py:28-31](../server/sql_service/sqlparams.py)）

**验收**：`test/expression.test.ts` 每个过滤器三例（正常 / 空集 / 类型错）；`test/referenceSelection.test.ts` 新模式编译；`uxContract` 断言展示文案不含 `$.`。

### 3.5 流程入参升级 + 记住上次入参（#5）

**现状**：`FlowInputField` 只有 `string | integer | boolean` 和 `required`（[types.ts:204-209](../src/types.ts)）；无默认值、无说明；
运行表单每次重进编辑器都清空（[store.ts:1257](../src/store.ts)）。日报最常见的入参「日期」今天是一个要手敲 `2026-08-21` 的文本框。

**设计**（Dify Start 节点 + AP 记住测试数据）：

- `FlowInputField.type` 作为 **UI 种类**扩成 `string | integer | number | boolean | date | select`，新增 `default?` / `description?` / `options?`。
  `date` / `select` 不是 JSON Schema 类型（`JsonSchema.type` 的联合在 `types.ts:101`），所以 `toDefinition`（`store.ts:1157-1160`）要映射成
  `date → {type:'string', format:'date'}`、`select → {type:'string', enum}`、`number → {type:'number'}`，`loadDefinition`（`:1237-1242`）反向。
  [flowImport.ts:84-91](../src/lib/flowImport.ts) 对属性 schema 是透传的，`default / description / enum / format` 能活下来
- 所有按入参类型分支的地方一起改，漏一处就是「表单显示日期、引擎当字符串」：[runRequest.ts:15-19](../src/lib/runRequest.ts) `triggerFromForm`、
  `store.ts:1072`（testStep 里有一份重复的转换 —— 收敛到 `triggerFromForm`）、[webhookExample.ts:30](../src/lib/webhookExample.ts)、
  [FlowInputsEditor.tsx:35-44](../src/components/FlowInputsEditor.tsx)、[RunPanel.tsx:151-160](../src/components/RunPanel.tsx)、
  [webhooks.py:286, 294-311](../server/sql_service/webhooks.py) `_coerce`（补 `number`；`date` 校验 `^\d{4}-\d{2}-\d{2}$`）
- RunPanel 按种类渲染：`date` 用 `<input type=date>`（值天然是 `yyyy-MM-dd`），`select` 下拉，`boolean` 开关；`description` 当 placeholder
- 默认值要**灌进表单**而不只是 placeholder：`decideRunRequest` / RunPanel 用 `!form[key]?.trim()` 判缺（`runRequest.ts:34`、`RunPanel.tsx:113`），
  有默认值的必填项照样会拦住运行。`loadDefinition` 时用 default 初始化 `manualInputs`
- `manualInputs` 按流程落 `localStorage autoflow.inputs.<flowId>`，`loadDefinition` 回填、`clear`（`:1287`）清；表单旁「恢复默认」
- 服务端：[flowdef.py:114-115](../server/sql_service/flowdef.py) 现在只检查 `inputs` 是对象，补校验 `properties[*].type` 在 JSON Schema 集合内

**验收**：建「日期」入参默认 `2026-08-21` → 运行表单预填且不拦运行 → SQL `{{date}}` 自动代入（README 第 4 条机制不变）→ 关掉编辑器再开还在。

### 3.6 循环节点的假开关（#6）

**现状**：`concurrency` / `batchSize` / `continueOnItemError` 在 [registry.ts:356-358](../src/registry.ts)，引擎与 worker **零引用**；
worker 展开后写死 `okCount = 全部, failCount = 0`（[worker/index.ts:340-341](../worker/index.ts)）。用户把并发调到 10、期待快 10 倍，实际串行；
体内失败了，循环节点照样报「0 失败」。

**设计**：先**从 schema 里删掉**这三个字段（老流程里的孤儿参数无害，`exportParams` 不会再写出），`okCount / failCount` 由 worker 按体内步骤真实统计。
真正的并发 / 容错 / 收集见 3.18。假开关比没有开关更贵 —— 它让用户以为问题已经解决了。

### 3.7 节点可发现性（#7）

- `NodeType` 加 `keywords?: string[]`、`docsUrl?: string`；[NodePicker.tsx:96-98](../src/components/NodePicker.tsx) 的搜索并入 keywords
  （企微：发群 / 通知 / 机器人 / 报警；SQL：查数 / 取数 / hive / doris；HTTP：接口 / 调用 / api；条件：判断 / if；循环：遍历 / 每个；日期：昨天 / 时间）
- Inspector 标题栏 `?` 图标 → `docsUrl`（后端 manifest 同步；`sql.query` 指到 README 对应节）
- `http.request` 的 cURL 导入改由 manifest 声明 `x-ui.importers: ['curl']`，删掉 [SchemaForm.tsx:48](../src/components/SchemaForm.tsx) 里最后一个 `typeId ===`

### 3.8 快捷键帮助（#8）

新建 `src/lib/shortcuts.ts`：一张表（键、说明、作用域），`?` 键（非输入态）打开 `ShortcutsSheet`；`CommandPalette` 的 `hint` 改读这张表，两处不再各写一遍。
现在 13 组快捷键散在 `Canvas.tsx` / `App.tsx` / `Inspector.tsx` / `RefField.tsx` 四处，没有任何地方能看全。

### 3.9 定义一致性门禁 + 小修（#9）

- 写成 `test/manifestParity.test.ts`，照 [errorCodes.test.ts:15-22](../test/errorCodes.test.ts) 的现成模式（`execFileSync(server/.venv/bin/python, ['-c', …])`，
  venv 不存在则 skip，只读 stdout）：取 `manifest.ALL` 与 `registry.ts` 同名节点逐字段比对 `input.properties` / `x-ui` / `policy` / `description`
  （`runtime` 允许后端独有）。**registry 里有、manifest 里没有的注解要报错**，而不只是「不一致」—— `applyBackendNodes` 整份替换
  （[registry.ts:811-822](../src/registry.ts)），那些注解一上线就消失，而这正是 README 反复说的「只在线上坏，本地测不出来」
- 顺手：HTTP manifest 的 `timeoutMs / connectTimeoutMs / readTimeoutMs / verifySsl / retry*` 补 `group: 'advanced'`（前端 registry 已标，后端没标，线上会全部平铺）；
  `canvas.note.theme` 补 `labels`（现在下拉里是 `yellow` / `blue`）；删除死代码 [VarPicker.tsx](../src/components/VarPicker.tsx)、[TablePicker.tsx](../src/components/TablePicker.tsx)
  （`inserters: 'table'` 声明了但从未被消费，表格插入由取值面板承担，hermes M3 负责插入条）

### 3.10 ★ 连接（凭证）层（#10）

**现状**：企微 webhook（README 自己写着「等同凭证」）和 HTTP token 以明文存在 `flow_versions.definition` —— 而版本表**不可变**，轮换 key 之后旧版本里永远留着；
导出 JSON 即泄露；10 条流程共用一个群机器人 = 换机器人改 10 处；`notify.wecom.webhook` 连 `x-ui.secret` 都没标（[registry.ts:721](../src/registry.ts)），
运行记录的 `steps.input` 里也是明文（`redactNodeInput` 只管 http.request，[secrets.ts:49-64](../src/lib/secrets.ts)）。

**设计**（n8n Credentials 的最小形态；存法学 Activepieces —— 字段值是一个引用）：

- 表 `connections(id, owner, name, type, data_enc, created_by, created_at, updated_at, last_used_at)`，`data` 用 Fernet 加密，密钥 `CONNECTIONS_KEY` 环境变量
  （新增 `cryptography` 一个依赖）。没配密钥 → 接口 503 且 UI 提示「管理员未配置，暂时只能在节点里直接填」—— 与「没配 DATABASE_URL 也能用」同一约定
- 类型先做四种：`wecom.webhook{url}`、`http.bearer{token}`、`http.basic{username, password}`、`http.header{name, value}`
- 节点参数里存 **`conn:<id>`** 字符串：一个字段兼容老 URL 和新引用、JSON Schema 类型不变、运行记录里天然不含密文。
  manifest 声明 `x-ui: { widget: 'connection', connectionType: 'wecom.webhook' }`；HTTP 的 `authType` 加 `connection` 选项 + `connection` 字段（`x-show`），
  [vars.ts:248-258](../src/lib/vars.ts) 的认证必填检查补这一分支
- **密文只在服务端解**：`_do_wecom`（[main.py:467-478](../server/sql_service/main.py)）在调 `wecom.send` **之前**替换 —— `send` 会校验 URL（[wecom.py:36-60](../server/sql_service/wecom.py)），
  `conn:` 过不了；HTTP 在 `_apply_auth`（[http_request.py:209-234](../server/sql_service/http_request.py)）加 `connection` 分支按连接类型分发。
  浏览器 mock 不校验企微 URL（`engine.ts:665-672`），不用改
- **谁在用连接**：`execute_wecom` / `execute_http_request` 今天不收 `request`（`main.py:454-491`），拿不到身份。照 `postgres.workspace` 的样子（`:494-503`）
  加 `request: Request` → `identity.creator_for(request)`；worker 调用要带 `WORKER_TOKEN` + `X-Run-Creator`（[identity.py:109-133](../server/sql_service/identity.py)，拿不到就 fail-closed）。
  **后果要写进 README**：没配 `WORKER_TOKEN` 的部署，所有用到连接的后台运行都会 403。别人的连接 → 403「无权使用连接 X」
- UI：字段变下拉（列出本人该类型的连接）+「新建…」内联 +（企微）「发一条测试」；老流程里是裸 URL 时显示「直接填写的地址 · 存为连接」一键迁移；
  首页加「连接」标签页：列表、改名、轮换、删除（被引用时拒绝并列出流程）
- 导出 / 导入只带 id；导入后 `validateNode` 报「连接 c_x 不存在，请重新选择」
- 告警 `notify_config` 改存 `connectionId`（3.1 的后续）

**验收**：`test_connections.py`（加密往返、403、删除被引用）；浏览器里导出 JSON 不含 `qyapi.weixin.qq.com`；新发布的版本 `git grep` 不到明文。

### 3.11 重跑：同入参再跑 / 从失败节点续跑（#11）

**现状**：失败后连「再跑一次」都没有（`RunPanel.tsx` / `RunHistory.tsx` 无任何动作）。Hive 跑完 5 分钟、发企微时 500 了，整条运行的价值归零 —— 这是每天都在发生的损失。
后端条件已齐：`steps` 表按节点物化、worker 每步 `decide()` 从库重算、`POST /api/flows/{id}/runs` 收 `version`。

**设计**（n8n Retry execution / AP Retry from failed step；护栏照 improvement-plan M5 Redrive）：

- `POST /api/runs/{id}/rerun`（body `{ from: 'start' | 'failed' }`）→ 新建 run；新迁移给 `runs` 加 `redrive_of`
- [runstore.py](../server/sql_service/runstore.py) 新写 `rerun()`，**run 行 + 复制的 steps + `run.queued` 事件在同一个事务里提交**。
  `create_run` 是立即 commit 的（`:95-104`），worker 随时可能认领一条 `queued` 的 run（[worker/store.ts:53-74](../worker/store.ts)），
  先 commit 再补 steps 会被从头跑一遍
- `from: 'failed'`：把源 run 里 `success` 的 steps 复制过来 —— worker `loadSteps` 读的就是 `node_id, loop_path, status, input, output, matched, fanout, seq`
  （`worker/store.ts:166-184`），`matched` / `fanout` 缺了 `flow.if` / `foreach` 回放不了。`replayedFrom` 记在 `steps.progress`（JSONB，免迁移），`get_run` 吐出来。
  `decide()` 把预置的 `success` 行当终态（[decide.ts:176](../src/lib/engine-core/decide.ts)），ctx 从它们的 `output` 组装（`worker/index.ts:266-269`）；
  幂等键含新 `run.id`（`:370, 391`），不会撞
- **沿用源 run 的 `flow_version`、`scheduled_time`、`mode`、`trigger_input`** —— 否则复用的上游 SQL 结果是昨天的、新算的日期是今天的，两者对不上且完全静默。
  `flow_version` 由服务端传，不经客户端：草稿快照是负版本号，公共路由拒绝 `version <= 0`（`main.py:606-609`）。
  `trigger_kind` 用 `manual` —— 复制 `schedule` 会撞 `runs_sched_once_idx` UNIQUE `(flow_id, trigger_kind, scheduled_time)`；`idempotency_key` 置 NULL。
  快照安全：`purgeOrphanDraftVersions` 只删没有 run 引用的快照（`worker/store.ts:320-331`），源 run 与新 run 都引用着
- 源 run 已被保留期清掉（`RUN_RETENTION_DAYS`）→ 404「源运行已过保留期，只能整条重跑」。
  初稿写的「大输出 `$ref` 已清理 → 409」是虚构的：`OUTPUT_INLINE_LIMIT_BYTES` 零消费者，`steps.output` 全内联
- worker 以版本发布者身份跑（`publisherOf`，`worker/index.ts:156`），点重跑的人记在 `run.queued` 事件 payload 里
- UI：`RunPanel` 每条历史行尾「再跑一次 ▾」（同入参 / 从失败处）；`RunHistory` 同款；失败节点卡片角标点开「从这里重跑」；redrive 行显示「重跑自 昨天 09:01」

**验收**：`test/worker.test.ts`（需 Postgres）：SQL 成功、企微失败 → 从失败处重跑 → SQL 步骤带 `replayedFrom` 且不再提交平台任务；定时 run 重跑不撞唯一索引。

### 3.12 拖字段到输入框（#12）

- 取值面板候选项、Inspector「输出结构」芯片（[Inspector.tsx:170, 183](../src/components/Inspector.tsx)，现在是死的 `<code>`）、NDV 表头 / 单元格全部 `draggable`，
  `dataTransfer` 带 `text/plain` = 编译后的表达式 + `application/x-autoflow-ref`
- `RefField` 加 `onDrop`：按 `caretPositionFromPoint` 定位 → 走现有 `spliceAt` + `commit`。粘贴路径已经能胶囊化（[RefField.tsx:464](../src/components/RefField.tsx)），
  drop 只是换一个入口；`fitReason` 不合法时拒绝并 toast 原因；PlainField 同样处理
- 不改引用存储、不改编译

### 3.13 Webhook「监听一次」（#13）

- `webhooks` 表加 `capture_until timestamptz`、`last_capture jsonb`；`POST /api/flows/{id}/webhook/listen` 开 60 秒窗口
  （webhook 行在未发布时就能建，[webhooks.py:92-132](../server/sql_service/webhooks.py) `ensure`，面板先建再听）
- `/hooks/{token}` 在窗口内：放在 `_check_auth`（`:471`）**之后**、未发布 409（`:482-484`）之前，跳过 `map_inputs`（草稿入参和线上不同）；
  **不要求已发布**、不建 run，存 body / headers 后返回 `200 {captured: true}`—— n8n test webhook 的语义：草稿也能收。窗口外行为不变。
  存 body 与 `004_webhooks.sql`「不存 body 原文」的原则冲突：在迁移注释里说明例外（用户显式动作、单槽位、60 秒 TTL 后清空），
  并按 `MAX_PIN_BYTES` 256 KB 截断（[flowdef.py:29](../server/sql_service/flowdef.py)；入口上限是 1 MB）
- **范围限定为学 `$.trigger.*`**。评审发现触发器节点的 output 今天从未被填充：registry 声明了 `body / headers / remoteIp / receivedAt`（`registry.ts:166-174`），
  但 `handle` 只把映射后的 `inputs` 放进 `trigger_input`（`webhooks.py:486-504`），两个引擎对触发器都产出 `{}`。
  所以「把样例 pin 到触发器节点」只在手动模式生效、线上必炸。改为：收到样例后「按样例补全入参」—— 顶层键 → `flowInputs`（类型推断），样例值 → `manualInputs`，
  下游取值面板立刻能点到。把 raw body 作为触发器 output 真正吐出来（两个引擎 + `trigger_input.__webhook`）另开一条，不混在这里
- `WebhookPanel`「监听一次」→ 倒计时 → 收到后展示 body → 「按样例补全入参」；curl 示例旁加「用这份样例重发」

**验收**：`test_webhooks.py` 窗口内未发布 200 / 窗口外 409 / 超 256 KB 截断；UI 实测下游 `/` 能点到新入参。

### 3.14 首页「需要处理」（#14）

- `GET /api/flows` 每行带 `lastRun {status, startedAt, runId}`（lateral join `runs`，一条 SQL）；`SavedFlow` 同步
- 卡片：「上次 今天 09:01 ✗ SQL 超时」红点；顶部「需要处理（2）」条列出上次失败且之后没成功过的流程，点进直接开运行记录
- 这是 hermes H2 里「last run 完全缺席」的补完，也是 AP Issues 的最小形态；不做「标记已解决」状态

### 3.15 智能粘贴（#15）

- `copyNodes` 同时写系统剪贴板 `{"autoflow": 1, "nodes": […], "edges": […], "layout": {…}}`（`navigator.clipboard.writeText` 在 http 部署下会拒，要吞掉）
- 读取**不能**走 `navigator.clipboard.readText()`（要权限 + 安全上下文），也不能放在现有 `keydown` 里 —— [Canvas.tsx:596-603](../src/components/Canvas.tsx) 对 `Cmd+V`
  `preventDefault()`，原生 `paste` 事件根本不会来。改成 `window` 上的 `paste` 监听读 `event.clipboardData`，用 `isInputLike(target)`（`:636-639`，已含 contentEditable）
  让位给 `RefField` 自己的 `onPaste`；`keydown` 里的 `Cmd+V` 只在剪贴板里没有文本时兜底内存剪贴板
- 粘进来的 JSON 当不可信输入：不直接喂 `pasteNodes`（它信任完整的 `FNode`，[store.ts:473-520](../src/store.ts)），先过 `normalizeFlowDefinition`
- `curl …` 开头 → 指针处 `addNode('http.request')` 后按 [CurlImport.tsx:18-19](../src/components/CurlImport.tsx) 的方式逐键 `updateNodeParam`
- 已知缺口照实写：粘贴不重映射参数里的 `$.nodes.<id>` 引用（今天流程内粘贴就有这问题，跨流程更明显），校验会把它标成「引用了非上游节点」

### 3.16 NDV 导出（#16）

`RowsTable` 加「下载 CSV」「复制 JSON」；CSV 用 Blob + `<a download>`，文件名 `流程名-节点名-时间.csv`；`truncated` 为真时文件头一行注释说明只取回前 N 行。

### 3.17 失败出口（#17，批 3）

- `onError` 加第三值 `'branch'`；`portsOf(t, data)` 据此追加 `{ id: 'error', label: '失败' }`（红色手柄）；`decide.ts` 失败时激活 `error` 口、主口 dead；
  错误分支可引用 `$.nodes.<id>.error = { message, code, failureKind }`（`vars.ts` 暴露，取值面板显示为「错误信息」分组）
- 浏览器引擎镜像同一语义，golden 回放加用例；`flow.merge` 对 error 口的边按普通入边处理（局部 join 规则不变）
- UI：设置区选「走失败出口」后卡片长出红口并提示「把企微通知连到这里」

### 3.18 循环：收集结果 + 并发 + 容错（#18，批 3）

- 参数 `collect`（RefField，作用域 = 循环体内节点）→ 输出 `collected: any[]`；`continueOnItemError` 真实现；
  `concurrency` 在 worker 里按「同一 loopPath 下可并行的 ready 步骤数」限流；失败项在运行详情做状态网格（improvement-plan M5 原案）
- 前置：3.6 删掉假开关；本条做完再把开关加回来

### 3.19 动态下拉联动（#19，批 3）

`UiHint` 加 `dependsOn?: string[]`；`client.ts` 保留 label；`cachedOptions` 按 `(key, deps)` 缓存；字段打开时懒加载、可刷新、有 loading / 错误态；
服务端 `/options/{key}?engine=…`。**第一个消费者待确认**：DataLego 是否有队列 / 表目录接口；没有就只落契约不落 UI。

---

## 4. 明确不抄

| 不抄 | 来源 | 为什么 |
|---|---|---|
| item-based 隐式 fan-out | n8n | [roadmap.md](./roadmap.md) 已拍板：数据是结果集不是 item 批 |
| 线性构建器（无画布） | Activepieces | 画布 + 自动整理已成熟；换范式成本远大于收益 |
| AI Copilot / 自然语言建流程 | 三家都有 | 三份计划明确不加 Agent；先把确定性交互做对 |
| 节点市场 / 社区模板 | n8n / AP | 内部工具，节点由后端 manifest 注册，模板放 `templates.ts` 够用 |
| 多触发器共存 | n8n | [graph.ts:59-61](../src/lib/graph.ts) 单触发器 + `schedules` PK 已焊死；improvement-plan M3 留了决策点，本轮不动 |
| 凭证 RBAC / 共享 | n8n | 先做「本人可见」；共享等有第二个团队用再说 |
| CodeMirror 替换 SQL 框 | n8n / Dify | 300 KB+ 依赖换高亮；占位符胶囊已解决最痛的一半；等 Python 代码节点一起上 |
| 多分支 switch / 嵌套条件组 | Dify elif / AP Router | 串两个 `flow.if` 能表达；等真实流程出现三分支再做 |

---

## 5. 分批与排期

> **批 1 已落地**（2026-08-23，未提交）。和原设计的出入：
> - 3.6 只删了假开关；worker 的 `okCount / failCount` 仍在展开时写死 —— 真实统计要等 3.18 的 `waiting(fanout)` + finalize，
>   而且 3.18 要先解决一个现成问题：worker 在展开时就把 foreach 置 success，`done` 子树与迭代**并行**跑
> - 3.4 把 hermes 第三份计划的 M1 / M2（取值面板「汇总」：求和 / 去重个数 / 拼接）一并做了
> - 顺手修掉两个现成 bug：worker 在「只写了 skipped 行、没有可跑的」那一轮会交接出去而不是重算，run 停在 running 直到一小时后 reaper 来收；
>   `flowCardMeta` 对未缓存流程的壳定义读 `def.trigger.kind` 会把首页炸掉
> - 老版本服务端下发的三要素 `policy.retry` 会被 normalize（不算出 NaN），后端晚升级一天前端不坏

| 批次 | 内容 | 估算 | 用户能感知的变化 |
|---|---|---|---|
| **1 · 入口补齐**（不动引擎语义） | 3.1 失败通知 · 3.2 下次运行 · 3.3 节点设置 + 重试单源 · 3.4 过滤器 · 3.5 入参升级 · 3.6 删假开关 · 3.7 别名 / 文档 · 3.8 快捷键 · 3.9 一致性门禁 | 4–5 天 | 日报挂了群里有人知道；定时器看得见下次几点；能暂停企微节点调 SQL；「只发 dc > 5 的前 10 名」不用改 SQL |
| **2 · 闭环** | 3.10 连接 · 3.11 重跑 · 3.12 拖拽 · 3.13 监听一次 · 3.14 需要处理 · 3.15 智能粘贴 · 3.16 导出 | 7–8 天 | 不再粘 webhook；企微 500 了点一下续跑；首页红点；拖一下就是引用 |
| **3 · 引擎** | 3.17 失败出口 · 3.18 循环 · 3.19 动态下拉 | 6–8 天 | 失败走分支；对每个 vid 查一次再汇总 |

依赖：3.10 → 3.1 的连接下拉；3.11 → Postgres 模式；3.6 → 3.18；hermes 第三份计划的 M1 / M2（汇总）与 3.4 改同一批文件，**由同一人连续做**。

---

## 6. 验证

- 每批：`npm run check`（constants + tsc + 全部测试）+ `server/.venv/bin/python test_*.py`；批 1 起 `npm test` 里多一条 `manifestParity`（有 venv 才跑）
- 批 1 手测旅程：
  1. 流程设置填失败通知 → 写坏 SQL → 顶栏运行 → 群里收到告警；再跑一次 → 被抑制
  2. 定时节点显示下次三次时刻；切到按间隔 → 预览跟着变
  3. 暂停企微节点 → 运行 → 该节点灰色 skipped，SQL 照跑；恢复后正常
  4. 企微正文 `/` → SQL → 按条件「保留全部匹配行」+ 前 10 → 预览是表格不是路径
  5. 入参加「日期」默认昨天 → 运行表单预填 → 关掉编辑器再打开还在
- 批 2 加：导出 JSON 不含 webhook 明文；企微故意 500 → 「从失败处重跑」不再提交 Hive 任务；拖一个列头进企微正文出现胶囊

---

## 7. 默认决策（实现时不再问）

1. 连接引用存 `conn:<id>` 字符串，不改字段类型
2. 暂停 = 对下游活性透明；下游**引用**暂停节点的值才报错，不给空值
3. 重跑一律新建 run（列表一行一次运行），不在原 run 上续；`trigger_kind` 用 `manual`
4. 假开关先删不先实现
5. 聚合过滤器遇空集返回 `undefined`（`default()` 能兜），类型错才抛错
6. `note` 不算逻辑改动（不触发「未发布」），`disabled` 算
7. HTTP 节点只保留一层重试：节点级设置映射到节点内参数，worker 不再对它二次重试
8. 监听一次只学 `$.trigger.*`，不碰触发器 output

---

## 8. 顺带发现、不在本文范围的问题

- [flowCardMeta.ts:24](../src/lib/flowCardMeta.ts) 对未缓存流程的壳定义读 `def.trigger.kind` 会抛错 —— 换台机器或进管理台，首页白屏。已单独立项
- `VarPicker.tsx`、`TablePicker.tsx` 是死代码（3.9 顺手删）
- `/api/runs/{id}/events` 服务端实现了、前端没用（`remoteRun.ts` 轮询 `getRun`）—— 不影响功能，留着

---

## 9. 评审推翻的初稿决策

写下来是为了以后不用重新踩：

| 初稿 | 为什么错 | 改成 |
|---|---|---|
| 暂停节点 = `skipped` | `decide.ts:210-224` 会把 `skipped` 上游的整条下游判 `unreachable` | pass-through，两个引擎同改 + 等价性测试 |
| 通知配置挂在 `PUT /api/flows/{id}` | 那是自动保存通道，body 只有 `definition`，且不记审计 | 子资源 `/api/flows/{id}/notify` |
| 重跑复制源 run 的 `trigger_kind` | 撞 `runs_sched_once_idx` 唯一索引 | `trigger_kind = 'manual'`；steps 与 run 同事务插入 |
| 监听一次 → pin 到触发器节点 | 触发器 output 从未被任何引擎填充，pin 只在手动模式生效 | 只学 `$.trigger.*`，按样例补全入参 |
| 系统剪贴板在 `keydown` 里读 | `Cmd+V` 被 `preventDefault`，原生 paste 不会来；`readText()` 要权限 | `window` 的 `paste` 事件读 `clipboardData` |
| 入参类型直接加 `date` / `select` | 不是 JSON Schema 类型，`toDefinition` 原样写出 | UI 种类映射到 `string + format / enum` |
| 聚合空集抛错、`default()` 兜底 | `default` 接不住 `applyFilter` 内部抛的错 | 空集返回 `undefined` |
| 节点级 `retry` 存 `{maxAttempts, initialMs}` | worker 的 `backoffMs()` 要 `backoffCoefficient / maximumIntervalMs` | 扩 `RetryPolicy` 对齐 `RetrySpec` |

---

## 附：批 1 任务清单

> 给 Hermes 或人用。每条：目标 → 文件 → 步骤（先写失败测试）→ 提交。提交信息照仓库风格：中文标题写用户看见的症状，正文讲为什么。

### Task 1 · 失败通知入口（3.1）

**Files**：`server/sql_service/flowstore.py`（`set_notify_config`、`get_flow` / `_summary` 补列）· `server/sql_service/main.py`（`GET/PUT /api/flows/{id}/notify`）·
`server/test_flowstore.py` · `src/lib/client.ts` · `src/lib/library.ts`（`SavedFlow.notifyConfig`）· `src/store.ts` · `src/components/Inspector.tsx`（FlowInspector）·
`worker/alerts.ts:104`（`PUBLIC_APP_URL`）· `src/lib/appRoute.ts` + `test/appRoute.test.ts`（`/?run=`）· `src/components/Home.tsx` · `deploy/env.example` · `docker-compose.yml`

1. `test_flowstore.py`：`set_notify_config` 往返 + 审计行 `flow.notify`（需 Postgres，没有就 skip，照现有用例）
2. `test/appRoute.test.ts`：`routeFromPath('/?run=r_1')` → `{ kind: 'home', runId: 'r_1' }`
3. 实现子资源 + 前端一节 + 首页按 `runId` 自动打开 RunHistory
4. `alerts.ts`：有 `PUBLIC_APP_URL` 时链接改 `${PUBLIC_APP_URL}/?run=${id}`，否则原样

**Commit**：`feat: 日报挂了终于有人知道 —— 失败通知有了入口，告警链路之前是条死路`

### Task 2 · 定时触发下次运行（3.2）

**Files**：`src/types.ts:36` · `src/lib/schedule.ts`（`nextRunTexts`）+ `test/schedule.test.ts`（新）· `src/components/SchedulePreview.tsx`（新）·
`src/components/SchemaForm.tsx:290` · `src/registry.ts`（`trigger.schedule` 根 `x-ui.preview`，`timezone` 去掉 `group`）·
`server/sql_service/flowstore.py list_flows`（JOIN `schedules`）· `src/lib/client.ts` · `src/lib/library.ts` · `src/lib/flowCardMeta.ts` + 测试 · `src/components/Home.tsx`

1. `test/schedule.test.ts`：`nextRunTexts({mode:'daily', at:'09:00', timezone:'Asia/Shanghai'}, new Date('2026-08-22T02:00:00Z'))` 三条；非法 cron 返回 `[]` 不抛
2. 组件 + registry 挂载；调度器离线时显示 `SCHEDULER_OFF_SHORT`
3. 列表接口带 `nextFireAt`，卡片显示；`flowCardMeta` 对没有 `trigger` 的壳不再抛

**Commit**：`feat: 定时节点看得见「明天 09:00 会跑」—— 算下次触发的函数写好一个月了没人调`

### Task 3 · 节点设置区 + 重试单一来源（3.3）

**Files**：`src/types.ts` · `src/lib/flowImport.ts` · `src/store.ts`（`toDefinition` / `loadDefinition` / `setNodeNote` / `setNodeDisabled` / `setNodeRetry`）·
`src/lib/engine-core/types.ts` `decide.ts` `errorCodes.ts` · `src/lib/engine.ts` · `worker/index.ts` · `server/sql_service/flowdef.py` `flowstore.py`（`logic()` 剥 `note`）·
`server/sql_service/manifest.py`（四节点 `policy.retry`；HTTP 三个重试字段 `x-hide` 或删除）· `src/registry.ts` ·
`src/components/Inspector.tsx` `FlowNodeView.tsx` `CanvasContextMenu.tsx` `Toolbar.tsx` `RunPanel.tsx` `RunHistory.tsx` · `scripts/check-flows.ts` ·
`test/flowGraph.test.ts`（往返）· `test/decide.test.ts` `test/equivalence.test.ts` `test/golden.test.ts` · `test/errorCodes.test.ts`

1. 往返测试：`normalizeFlowDefinition` → `loadDefinition` → `toDefinition` 三个字段不丢
2. `test/decide.test.ts`：A → B(disabled) → C，A 成功后 C 可跑；A 失败 + fail 时 C 仍 unreachable；B 是 `flow.if` 时 `disabled` 被忽略
3. `test/equivalence.test.ts` 同一用例两个引擎结果一致
4. 重试：`RetryPolicy` 扩展；worker 读 `{...t.policy.retry, ...node.retry}`；删 `DEFAULT_RETRY`；`errorCodes.test.ts` 改为断言每个 live 节点 manifest 都声明了 `retry`；HTTP 节点级 retry 映射到节点内参数
5. UI：设置区、卡片暂停态与备注、右键菜单；校验豁免
6. `flowstore.logic()` 剥 `note`，`test_flowstore.py` 断言改备注不产生「未发布」

**Commit**（可拆两次）：`feat: 节点能暂停、能写备注 —— 调 SQL 不用先把企微节点删掉再加回来` /
`fix: 重试次数只剩一个出处 —— manifest 说 2 次、worker 跑 3 次、HTTP 节点还自己再来一轮`

### Task 4 · 过滤器补齐（3.4）

**Files**：`src/lib/output.ts` `engine.ts` `selectionFilters.ts` `refLabel.ts` `referenceSelection.ts` `referenceFit.ts` · `src/components/DataReferenceDrawer.tsx` `MessagePreview.tsx` ·
`test/expression.test.ts` `test/referenceSelection.test.ts` `test/uxContract.test.ts` · `README.md` 过滤器表

1. `expression.test.ts`：`where(dc, gt, 5)` 保留多行；`limit(2)`；`avg(dc)` 空集 `undefined` 且 `| default('—')` 生效；`round(1)`；`percent()`；非数字报错
2. `referenceSelection.test.ts`：`where` / `top` / `avg` 编译；展示文案不含 `$.`
3. 引擎、面板、标签、校验、预览正则、README

**Commit**：`feat: 「只发 dc>5 的前 10 名」不用回去改 SQL —— 补上 where / limit / avg，改 SQL 意味着再跑一次 Hive`

### Task 5 · 入参升级 + 记住上次（3.5）

**Files**：`src/types.ts` · `src/store.ts` · `src/lib/runRequest.ts` + `test/runRequest.test.ts` · `src/lib/webhookExample.ts` + 测试 · `src/components/FlowInputsEditor.tsx` `RunPanel.tsx` ·
`server/sql_service/flowdef.py` + `test_flowdef.py` · `server/sql_service/webhooks.py` + `test_webhooks.py`

1. `runRequest.test.ts`：`date` / `select` / `number` 的 `triggerFromForm`；有默认值的必填项不判缺
2. `test_webhooks.py`：`_coerce` 对 `date` 校验格式、对 `number` 转浮点
3. `toDefinition` / `loadDefinition` 映射；往返测试
4. 编辑器与运行表单；`localStorage autoflow.inputs.<flowId>`

**Commit**：`feat: 入参有了日期和下拉，还记得上次填的 —— 日报的日期以前是每天手敲一遍的文本框`

### Task 6 · 删循环假开关（3.6）

**Files**：`src/registry.ts:356-358` · `worker/index.ts:338-342`（按体内步骤统计 `okCount / failCount`）· `test/worker.test.ts`

**Commit**：`fix: 循环节点的并发和容错开关根本没接线 —— 先摘掉，假开关比没有开关更贵`

### Task 7 · 别名 / 文档链接 / cURL 声明化（3.7）

**Files**：`src/types.ts`（`keywords` / `docsUrl` / `UiHint.importers`）· `src/registry.ts` · `server/sql_service/manifest.py` · `src/components/NodePicker.tsx` `Inspector.tsx` `SchemaForm.tsx:48,273` · `docs/node-contract.md`

**Commit**：`feat: 搜「发群」能找到企微节点 —— 加节点时用户想的是动作，不是节点名`

### Task 8 · 快捷键帮助（3.8）

**Files**：`src/lib/shortcuts.ts`（新）· `src/components/ShortcutsSheet.tsx`（新）· `src/components/Canvas.tsx` `App.tsx` `CommandPalette.tsx` · `README.md`

**Commit**：`feat: 按 ? 看全部快捷键 —— 十三组快捷键散在四个文件里，没有一处能看全`

### Task 9 · 定义一致性门禁 + 小修（3.9）

**Files**：`test/manifestParity.test.ts`（新，照 `test/errorCodes.test.ts`）· `server/sql_service/manifest.py`（HTTP 高级分组、`description` 对齐）· `src/registry.ts`（`canvas.note.theme` labels）·
删 `src/components/VarPicker.tsx` `TablePicker.tsx`

1. 先跑 parity 测试看现有漂移，逐条决定以哪边为准（`description` 以后端为准；`x-ui.group` 以前端为准并补到后端）
2. 删死代码，`tsc` 过

**Commit**：`test: 前后端节点定义对一遍 —— 线上整份覆盖，前端单独加的注解一上线就没，本地永远测不出来`
