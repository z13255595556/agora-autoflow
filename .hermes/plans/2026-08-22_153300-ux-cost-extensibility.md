# AutoFlow Studio 使用成本 / 交互 / 扩展性改造计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** 让业务同学不写 `$.nodes.n2.output.rows[0].token` 也能拼出「查数 → 加工 → 发企微」，同时让加一种节点只交一份 manifest，不再改前端特判。

**Architecture:** 不换引擎、不换画布库、不做成 Dify。底层继续把引用编译成现有 `{{ $.nodes... | filter }}` 表达式，旧流程照跑。交互层把「路径编程」收成芯片 + 形态选择器；配置层把 Inspector 做成日常填表、NDV 做成看数据；扩展层把所有 UI 特判收进 JSON Schema / `x-ui` / `outputShape`，后端 `GET /registry/nodes` 整份覆盖同名节点。

**Tech Stack:** React 18 + `@xyflow/react` + Zustand + 现有 `outputShape` / `referenceSelection` / `RefField` + FastAPI manifest + `node --test --experimental-strip-types`

**参照（只偷手感，不换产品定位）：** Make 的字段点选、n8n 的 Tab/Focus Panel/命令栏、Dify 的起始占位与可折叠面板、React Flow Workflow Editor 模板（与本仓库同栈）。

---

## Current context / assumptions

已经有、不要重做：

- 画布：弹出式 `NodePicker`、连线中点 `+`、悬停工具条、NDV、Inspector 浮层、`Cmd+K` 搜画布节点、模板 `src/lib/templates.ts`
- 引用：`outputShape.ts`（按形态出 UI，禁止按 `typeId` 分支）、`referenceSelection.ts`（选择 → 表达式）、`DataReferenceDrawer.tsx`、`RefField.tsx` 胶囊（`localStorage autoflow.chips !== 'off'`）、`test/referenceSelection.test.ts`
- 扩展：`NodeType` + `x-ui` / `x-output-ui` / `x-placeholders` / `x-show`；`applyBackendNodes` 覆盖注册表；`sql.query` / `http.request` / `notify.wecom` 由后端 manifest 整份下发

仍然贵的使用成本：

1. `/` 弹出的 `VarPicker` 仍并列显示 `$.nodes.n2.output.rows` 这种路径
2. 胶囊和抽屉不是所有字段的默认路径；SQL/JSON 大框、KV、HttpRequestForm 可能仍是朴素文本
3. 单击选中就开 Inspector，双击再开 NDV，两套表单叠在一起；节点卡片同时堆摘要、校验条、警告条、角标、工具条、节点 id
4. 空画布要会找左上角「添加」；`Tab` 不加节点
5. `HttpRequestForm.tsx` 是一份手写特判，新节点再走这条路扩展性归零
6. 报错和校验仍可能把内部路径甩给用户（与 `docs/visual-data-reference-design.md` §9 不符）

**非目标（YAGNI）：**

- 不把引用改存结构化 JSON 进 `FlowDefinition`（设计稿第三阶段；本轮仍编译成表达式，兼容旧流程）
- 不上 CEL、不上 Python 代码节点、不换 xyflow、不加 RAG/Agent 节点
- 不做 RBAC、不做多租户
- 不重写 worker / 引擎语义

**硬约束（实现时不许打破）：**

- `outputShape.ts` 不得 import `vars` / `engine` / 任何组件（见文件头注释，防环）
- 想被 `node --test` 跑的文件，值导入链每一环带 `.ts` 扩展名
- `sql.query` / `http.request` / `notify.wecom` 的展示注解必须写在 `server/sql_service/manifest.py`（及对应模块），**不要只改** `src/registry.ts` —— 后端一上线会整份覆盖，且「只在线上没，本地测不出来」
- 前端校验只是体验；保存/执行语义以现有 `flowdef` + 引擎为准，本轮不改执行结果

**验证总命令（每阶段结束跑一遍）：**

```bash
cd /Users/zhaojiwei/Desktop/项目/workflow
npm test
npm run check:constants
npx tsc -b
```

后端若动到 manifest 字段名：

```bash
cd server && .venv/bin/python test_flowdef.py
```

---

## Proposed approach

三条并行轨道，按用户感知排序实施：

| 轨道 | 用户感知 | 扩展性收益 |
|---|---|---|
| A 数据引用默认化 | 「点格子，不要写路径」 | 新节点只声明 output schema |
| B 画布与配置分层 | 少点一次、卡片变轻 | Inspector 只吃 schema |
| C 扩展面收口 | 加节点不再改三个 TSX | 干掉 `HttpRequestForm` 特判 |

实施顺序：A1–A6 → B1–B6 → C1–C5 → 文档与验收。

---

## Step-by-step plan

### Task 1: 验收清单写成可勾测试夹具

**Objective:** 把「用户不该看见路径」变成断言，后面每改一次都能回归。

**Files:**
- Create: `test/uxContract.test.ts`
- Modify: none yet

**Step 1: Write failing test**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { selectionDisplayLabel, compileReferenceSelection } from '../src/lib/referenceSelection.ts'
import { describeBlock } from '../src/lib/refLabel.ts'

test('展示文案不含 $. 路径', () => {
  const sel = {
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows',
    mode: 'at' as const, index: 0, column: 'token',
    valueType: 'string' as const, label: 'token · 第 1 行',
  }
  const shown = selectionDisplayLabel(sel)
  assert.equal(shown.includes('$.'), false)
  assert.equal(shown.includes('n2'), false)
  assert.match(compileReferenceSelection(sel), /\$\.nodes\.n2/)
})
```

**Step 2: Run test to verify failure or pass**

Run: `node --test --experimental-strip-types test/uxContract.test.ts`

- 若 `selectionDisplayLabel` 已满足：标 PASS，保留作为回归锁
- 若 `describeBlock` 仍吐路径：下一步改 `refLabel.ts`

**Step 3: Commit**

```bash
git add test/uxContract.test.ts
git commit -m "test: lock user-facing labels free of JSON paths"
```

---

### Task 2: Slash 列表不再展示内部路径

**Objective:** `/` 弹出的每一行只显示「SQL 查询 · token」+ 类型，路径留给 tooltip / 高级。

**Files:**
- Modify: `src/lib/slash.ts`
- Modify: `src/components/VarPicker.tsx`
- Modify: `src/lib/vars.ts`（`VarEntry` 补 `displayLabel?: string`，不要删 `path`）
- Test: `test/uxContract.test.ts` 增补 `filterSlashVars` 用例

**Step 1: Write failing test**

在 `test/uxContract.test.ts` 加：

```ts
import { filterSlashVars } from '../src/lib/slash.ts'

test('slash 候选项的展示名不含 $.', () => {
  const vars = [{
    path: '$.nodes.n2.output.rows',
    label: '结果行',
    group: 'SQL 查询',
    type: 'array',
  }]
  const [hit] = filterSlashVars(vars, '结果')
  assert.ok(hit)
  assert.equal((hit.displayLabel ?? `${hit.group} · ${hit.label}`).includes('$.'), false)
})
```

**Step 2: Run to verify failure**

Run: `node --test --experimental-strip-types test/uxContract.test.ts`

Expected: FAIL — `displayLabel` 不存在，或实现后才能绿。

**Step 3: Minimal implementation**

- `VarEntry` 增加可选 `displayLabel`
- `availableVars` 用节点 `data.label` + 字段 `title` 拼展示名
- `VarPicker` 主行只渲染 `displayLabel`；`<code class="varpicker__path">` 改成 `title={item.path}`，默认不占一行
- **不要**改 `onPick` 仍传 `path` —— 插入通道继续是表达式

**Step 4: Run tests**

`node --test --experimental-strip-types test/uxContract.test.ts test/expression.test.ts`

Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/slash.ts src/lib/vars.ts src/components/VarPicker.tsx test/uxContract.test.ts
git commit -m "fix(ux): hide JSON paths in slash variable picker"
```

---

### Task 3: 胶囊作为文本字段默认，而不是可选皮肤

**Objective:** 凡是能写引用的字段，打开就是胶囊；用户看见标签，不看见表达式。

**Files:**
- Modify: `src/components/SchemaForm.tsx`（所有走 `RefField` 的 text/textarea/code）
- Modify: `src/components/RefField.tsx`（`chip` 默认 true；`secret` / `x-ui.expr === false` / `canChipify` 失败仍降级）
- Modify: `src/components/HttpRequestForm.tsx` 的 URL / body / header value（在 Task 14 删掉之前先对齐）
- Test: 已有 `test/blocks.test.ts`；补一条 `canChipify` 对混合文本+引用的用例

**实现要点：**

- 保持 `localStorage autoflow.chips === 'off'` 总开关（控制台逃生口，禁止删）
- SQL 字段 `placeholders: true`：裸 `{{vid}}` 不芯片化，只有 `{{ $.… }}` 芯片化（已有 `sqlInertAt`）
- KV 的 value 必须走同一个 `RefField`，禁止第三套插入逻辑

**验证：** 手动：在企微 `content` 里 `/` 选「SQL · 行数」，输入框出现一枚不可拆胶囊；导出 JSON 里仍是 `{{ $.nodes.n2.output.rowCount }}`。

**Commit:** `feat(ux): default chip mode for all reference-capable fields`

---

### Task 4: `/` 的第一跳改成「选上游节点」，而不是平铺全部字段

**Objective:** 对齐设计稿 §5.1：先选节点，再按形态进抽屉；字段少于 4 个的标量节点（日期）可一步插入。

**Files:**
- Modify: `src/lib/slash.ts` — 增加 `slashLevel: 'source' | 'field'`
- Modify: `src/components/VarPicker.tsx` — source 级只列出上游节点
- Modify: `src/components/RefField.tsx` / `ReferencePickerContext.tsx` — 选中节点后 `openDrawer({ nodeId, sourceId })`
- Modify: `src/components/DataReferenceDrawer.tsx` — 打开时定位到该 source
- Test: `test/uxContract.test.ts`

**行为：**

| 上游输出 | `/` 后回车 |
|---|---|
| 日期计算（若干标量） | 展开该节点字段，再回车插入 |
| SQL / HTTP / 列表 | 打开 `DataReferenceDrawer`，不插入整坨 `output` |
| 流程入参 | 直接插入 `$.trigger.<key>`，展示名用入参 title |

**禁止：** 一次回车插入整个 `$.nodes.n2.output`（用户几乎总是想要一列或一个字段）。

**Commit:** `feat(ux): two-step slash pick (source then shape)`

---

### Task 5: 未知结构时给「下一步」，不要给空列表

**Objective:** 落实设计稿 §7.2：动态输出还没学到时，抽屉写「还不知道会返回哪些数据」+ 仅对 `x-dynamic` 节点显示「运行此节点 / 获取字段」。

**Files:**
- Modify: `src/lib/outputShape.ts` — `OutputShape` 已有 `known` / source；补 `canProbe: boolean`（只读 `output['x-dynamic']`，不要 import registry 循环：把 type 当参数传入）
- Modify: `src/components/DataReferenceDrawer.tsx`
- Test: `test/outputShape.test.ts`

**Step 1: Failing test**

```ts
test('未探测的 SQL 不编造列，且 canProbe=true', () => {
  const shape = describeOutput(sqlNodeWithoutProbe, { run: null, pinData: {}, nodes: [sqlNodeWithoutProbe], edges: [] })
  assert.equal(shape.regions.some((r) => r.kind === 'table' && r.table && r.table.columns.length > 0 && !r.known), false)
  assert.equal(shape.canProbe, true)
})
```

**实现：** `testStep(sourceId)` 已在 drawer 里部分存在（`testError`）。收成空态组件，**不能探测的节点不渲染该按钮**。

**Commit:** `fix(ux): empty dynamic output offers probe, never guessed columns`

---

### Task 6: 用户语言报错，路径只进详情

**Objective:** 校验和运行失败用「SQL 查询 · token 没有找到…」，主文案禁止 `Cannot resolve $.…`。

**Files:**
- Modify: `src/lib/vars.ts` `validateNode` 的引用错误文案
- Modify: `src/lib/engine.ts` / `src/lib/engine-core` 表达式未命中错误（**只改 message 字符串**，不要改抛错时机；未命中必须仍失败，见 README StrictUndefined）
- Modify: `src/lib/refLabel.ts` — 供引擎复用的 `humanizeExpr(expr, labelCtx)`
- Test: `test/expression.test.ts` 现有「未命中报错」用例改为断言中文/标签，同时断言仍然 throw

**注意：** worker 与浏览器共用 `engine.ts` 的 `resolveTemplate`。改文案两端一起变。不要在 engine 里 import React 组件。

**Commit:** `fix(ux): humanize missing-reference errors`

---

### Task 7: 单击 = 配参数，双击 = 看数据

**Objective:** 降低「改个引擎还要进全屏 NDV」的成本；对齐 n8n Focus Panel 的意图，但用现成 Inspector。

**Files:**
- Modify: `src/components/Canvas.tsx` — 节点 `onDoubleClick` 继续 `openNdv`；单击只 `select`
- Modify: `src/components/Inspector.tsx` — 标题区留「查看输入/输出」按钮（现有 `openNdv`）；底部试运行保留
- Modify: `src/components/NodeDetailView.tsx` — 默认 tab = 输出；参数栏加一句「日常配置请用右侧面板」，或直接藏参数 tab（推荐：**保留参数 tab** 以免老用户迷路，但不作为默认）
- Modify: `src/components/FlowNodeView.tsx` — 悬停「详情」文案改成「查看数据」
- Modify: `src/store.ts` — 确认 `openNdv` 不会在 `select` 时被误调

**不要做：** 选中时自动打开 NDV；不要改成常驻右侧双栏（Inspector 浮层约定已写在文件头）。

**验证：** 单击 SQL 节点 → 右侧出表单，画布仍可见；双击 → NDV 三栏，焦点在输出。

**Commit:** `feat(ux): inspector for edit, NDV for data`

---

### Task 8: 节点卡片减料

**Objective:** 默认只看见图标 + 名称 + 一行摘要 + 一个状态点；细节悬停/选中再出现。

**Files:**
- Modify: `src/components/FlowNodeView.tsx`
- Modify: `src/styles.css`（`.node` / `.node__errline` / `.node__tools` / `.node__nid`）
- Modify: `src/lib/summary.ts` — 摘要继续承担「配成了什么」

**具体改动：**

1. 去掉卡片上常驻的 `#n2`（`node__nid`）。选中或悬停再显示 id，或只放在 Inspector 标题
2. `node__errline` / `node__warnline` 收成左侧色条 + 角标数字；完整句子放 `title` 和 Inspector
3. `node__tools` 仅 `hover` 或 `selected` 显示（CSS 已有则检查是否被摘要高度顶没）
4. 运行角标保留一个：✓ / ✗ / ⚠ / spinner，不要同时钉 + 进度 + dirty 三个并排（📌 可与 ✓ 互斥：pinned 只显示 📌）

**不要**改节点宽高计算到让自动布局错位：先读 `src/lib/layout.ts` 的 `NODE_W` / `NODE_H`，卡片视觉变矮时同步常量。

**Commit:** `refactor(ux): quieter node cards`

---

### Task 9: 空画布与 Tab 加节点

**Objective:** 新流程打开 2 秒内能加上第二个节点，不必找角落按钮。

**Files:**
- Modify: `src/components/Canvas.tsx` — 空画布（仅触发器）显示三颗快捷芯片：SQL / HTTP / 打开选择器（README 已写「空流程快捷开始」，核对是否被 CSS/条件弄没）
- Modify: `src/components/Canvas.tsx` 键盘：无输入焦点时 `Tab` 打开 `NodePicker`（`preventDefault`，以免焦点跑到浏览器）
- Modify: `src/components/NodePicker.tsx` — 空查询时置顶 `recentNodeTypes`，再置顶 `sql.query` / `http.request` / `notify.wecom` / `date.compute`
- Test: 无（纯 UI）。手动清单写入本文件验收节

**冲突：** 现有 `Cmd+K` 打开 `CanvasNodeSearch`（找已有节点）。保持：

| 键 | 作用 |
|---|---|
| `Tab` | 添加节点（NodePicker） |
| `Cmd+K` | 定位已有节点 或 下一步并入命令栏（Task 11） |

**Commit:** `feat(ux): Tab opens node picker; empty-canvas shortcuts`

---

### Task 10: 起始占位 —— 换触发器零成本

**Objective:** 新建流程不要先理解「入口不能删」；换「定时/手动/Webhook」是原位替换（代码里已有替换语义），UI 要让人找得到。

**Files:**
- Modify: `src/components/FlowNodeView.tsx` — 触发器卡片主按钮「更换触发方式」打开只含 `category === '触发器'` 的 NodePicker
- Modify: `src/store.ts` — 确认已有「替换入口、保留 id/位置/下游边」；若只存在于 README，补 `replaceTrigger(typeId)`
- Modify: `src/lib/templates.ts` — 空白模板只放触发器，不要强迫用户从「定时查询 SQL」起步（那个模板留着，但是「空白」入口）
- Test: `test/graph.test.ts` 或 `test/flowGraph.test.ts` 补：替换触发器后下游边仍在、节点 id 不变

**Commit:** `feat(ux): in-place trigger swap from the start card`

---

### Task 11: 整站命令栏（Cmd+K）

**Objective:** 一个入口覆盖「找节点 / 加节点 / 运行 / 发布 / 回首页」，降低顶栏按钮密度。

**Files:**
- Create: `src/lib/commands.ts` — 纯函数 `buildCommands(ctx) => Command[]`
- Create: `src/components/CommandPalette.tsx`
- Modify: `src/components/Canvas.tsx` — 去掉只搜节点的专用 `Cmd+K`，改派发到 palette
- Modify: `src/components/Toolbar.tsx` — 放大镜走同一 palette
- Test: `test/commands.test.ts`

**Command 形状：**

```ts
export interface Command {
  id: string
  group: '流程' | '节点' | '运行' | '导航'
  label: string
  hint?: string
  enabled?: boolean
  run: () => void
}
```

第一期命令（YAGNI，别做模糊 AI）：

- 添加节点…（打开 NodePicker）
- 运行流程 / 试运行选中节点
- 整理画布 / 适应画布
- 发布（无后端时 `enabled: false`）
- 回到流程列表
- 跳转到节点「…」（现有 CanvasNodeSearch 数据）

**测试：** `buildCommands` 在 `selectedId == null` 时不含「试运行选中」；`storage === 'local'` 时发布 disabled。

**Commit:** `feat(ux): command palette on Cmd+K`

---

### Task 12: Inspector 默认只展示「每次都要改」的字段

**Objective:** HTTP 14 个字段平铺是使用成本。`x-ui.group: 'advanced'` 已有，要保证 **SchemaForm 真的折叠**，且后端 manifest 与前端 registry 同步。

**Files:**
- Modify: `src/components/SchemaForm.tsx` — 确认 `group === 'advanced'` 进「高级设置」`<details>`，默认收起
- Modify: `src/registry.ts` — `http.request` / `sql.query` 的 timeout、limit、queue、retry、verifySsl 全部 `group: 'advanced'`
- Modify: `server/sql_service/manifest.py` 及 `http_request` / `wecom` 的 manifest **同步同一批字段**（见硬约束）
- Test: 前端用纯函数抽出 `partitionFields(schema) => { main, advanced }`，单测它；后端 `test_flowdef.py` 不因缺字段挂

**抽函数（避免只在 JSX 里写）：**

```ts
// src/lib/schemaFields.ts
export function partitionFields(schema: JsonSchema): { main: string[]; advanced: string[] }
```

**Commit:** `fix(ux): collapse advanced schema fields by default`

---

### Task 13: 目标字段类型约束插入

**Objective:** URL / 请求头 / SQL 参数不允许插入整表或对象；插错时选择器禁用并说明原因，而不是插进去运行期炸。

**Files:**
- Create: `src/lib/referenceFit.ts`
- Modify: `src/components/DataReferenceDrawer.tsx` — 不合法候选 `disabled` + 原因
- Modify: `src/types.ts` `UiHint` — 可选 `valueKind?: 'scalar' | 'url' | 'sql' | 'message'`（已有 `inserters`，能复用就复用，不要叠两套）
- Test: `test/uxContract.test.ts`

```ts
export function fitReason(sel: ReferenceSelection, expected?: JsonType | 'url' | 'message'): string | null
// null = 可以插入
```

规则（设计稿 §9 的最小集）：

- 文本/代码：只收 scalar；object/array 必须先选子字段或显式 `json` 过滤器
- `inserters` 含 `table` 的消息框：允许 `mode: 'table'`
- number widget：只收 integer/number

**Commit:** `feat(ux): block ill-typed reference inserts`

---

### Task 14: 用 SchemaForm 吃掉 HttpRequestForm

**Objective:** 扩展性关键刀。HTTP 不再有一份手写表单；认证、body 类型、超时全部靠 `x-show` + `x-ui`。

**Files:**
- Modify: `src/registry.ts` + `server` 侧 http manifest（字段已大体齐）
- Modify: `src/components/Inspector.tsx` — 删除 `import HttpRequestForm`，一律 `<SchemaForm schema={t.input} />`
- Modify: `src/components/CurlImport.tsx` — 若依赖 HttpRequestForm 的特殊回调，改成 `updateNodeParam`
- Delete after 确认无引用: `src/components/HttpRequestForm.tsx`
- Test: 现有条件显示测试在 `test/` 里搜 `x-show` / `display.ts`；补 `visibleFields(httpSchema, { method: 'GET' })` 不含 `body`

**迁移检查表：**

- [ ] GET 时无请求体
- [ ] Bearer 只在 `authType=bearer` 出现
- [ ] 敏感头遮罩（`sensitiveKeys` / `secret`）
- [ ] curl 导入仍能填满 method/url/headers/body

**Commit:** `refactor: drive HTTP node entirely from manifest schema`

---

### Task 15: 节点贡献契约（加节点清单）

**Objective:** 下一个内部服务注册节点时，对照一份清单即可，不必读完 `registry.ts`。

**Files:**
- Create: `docs/node-contract.md`
- Modify: `README.md` 「接后端时要改的地方」一节改为链到该文档
- Modify: `scripts/check-flows.ts` 或 `scripts/check-constants.sh` —— 能自动查的写成检查，不要只靠文档

**文档必须写死的条目：**

1. 交一份 JSON manifest：`type` / `typeVersion` / `input` / `output` / `runtime`
2. 动态列用 `x-dynamic: probe|run`，禁止前端 `if (typeId === ...)`
3. 展示用 `x-ui` / `x-output-ui`；敏感字段 `secret`
4. 自有 `{{name}}` 语法必须声明 `x-placeholders`
5. 后端整份覆盖：前端 `registry.ts` 里同名节点只是离线兜底
6. 新节点的「卡片摘要」走 `src/lib/summary.ts` 的通用规则（读 title + 首个必填），禁止再加 `switch (typeId)`
7. UI 测：`npm run check:flows` 用**后端注册表**不是前端兜底

**自动检查（最小）：** `scripts/check-constants.sh` 已存在。扩一条：`summary.ts` 若新增 `typeId ===` 分支则失败（可用 `rg`）。允许的 typeId 白名单写在脚本注释里，越少越好。

**Commit:** `docs: node contribution contract and guardrail`

---

### Task 16: summary / 校验 / 输出形态禁止新增 typeId 开关

**Objective:** 把扩展性从约定变成门禁，防止下一轮 UX 又写回特判。

**Files:**
- Modify: `src/lib/summary.ts`
- Modify: `src/lib/outputShape.ts`（已经声明不按 typeId 分支 —— 加测试锁死）
- Create: `scripts/check-no-typeid-ui.sh` 或并入 `check-constants.sh`
- Test: `test/outputShape.test.ts` 用假节点 `{ type: 'vendor.foo', output: { properties: { items: { type: 'array', items: { type: 'object' } } } } }` 断言描述为 `table` 或 `array`，不依赖注册表特例

**`check-constants` 扫描路径：**

```
src/components
src/lib/outputShape.ts
src/lib/summary.ts
src/lib/display.ts
```

禁止新增：`typeId === 'sql.query'` / `data.typeId ===`（`FlowNodeView` 里 scheduler/webhook 提示可暂时白名单，并在脚本里点名）。

**Commit:** `chore: fail CI when UI special-cases node type ids`

---

### Task 17: 模板用芯片友好的引用，并加一条「空白」

**Objective:** 从模板起步的人看到的是中文标签，不是路径；空白模板降低「删掉示例 SQL」的成本。

**Files:**
- Modify: `src/lib/templates.ts`
- Modify: `src/components/Home.tsx` — 新建菜单：空白 / 定时查询 SQL / 手动…
- Test: `test/library.test.ts` 或新 `test/templates.test.ts`：`TEMPLATES` 每条 `normalizeFlowDefinition` 能过；定时模板的 wecom content 含 `table(` 过滤器

空白模板：

```ts
{
  key: 'blank',
  name: '空白流程',
  desc: '只有一个手动触发，从画布 Tab 开始加节点',
  icon: '◻',
  build: () => ({ /* 仅 trigger.manual */ }),
}
```

**Commit:** `feat(ux): blank template and chip-friendly starter flows`

---

### Task 18: 运行面板与预览标注「这是哪一次的值」

**Objective:** 防止把预览当实时数（设计稿 §7.3）。

**Files:**
- Modify: `src/components/DataReferenceDrawer.tsx` — 样例旁显示 `来自 今天 15:04 的运行` 或 `固定数据` / `结构探测`
- Modify: `src/lib/outputShape.ts` `ValueSource` 已有 `pin | run | probe | schema`，抽屉把枚举译成中文
- Modify: `src/components/RunPanel.tsx` — 高度记忆已有；顶部用一句话说明「选中节点的配置在右侧，这里只负责跑和看历史」

**Commit:** `fix(ux): label preview provenance so users do not treat samples as live`

---

### Task 19: 全量回归与文档对齐

**Objective:** README 开头「当前无后端」已过时；UX 约定写进 README 短节，避免下一轮再抄 n8n 路径体验。

**Files:**
- Modify: `README.md` — 删/改过时首段；加「编辑器怎么用」：Tab 加节点、`/` 选数据、单击配置、双击看数、`Cmd+K`
- Modify: `docs/visual-data-reference-design.md` §11 — 把「第一阶段」标成对照本计划 Task 1–6 的完成定义
- Run:

```bash
cd /Users/zhaojiwei/Desktop/项目/workflow
npm test
npm run check
cd server && .venv/bin/python test_sqlparams.py && .venv/bin/python test_flowdef.py
```

Expected: 全部绿。

**Commit:** `docs: align README with editor UX and current backend`

---

## Files likely to change

| 路径 | 角色 |
|---|---|
| `src/lib/slash.ts` `vars.ts` `refLabel.ts` `referenceSelection.ts` `referenceFit.ts` `schemaFields.ts` `commands.ts` `summary.ts` `outputShape.ts` | 纯逻辑，必须先测 |
| `src/components/VarPicker.tsx` `RefField.tsx` `DataReferenceDrawer.tsx` `SchemaForm.tsx` `Inspector.tsx` `NodeDetailView.tsx` `FlowNodeView.tsx` `Canvas.tsx` `NodePicker.tsx` `CommandPalette.tsx` `Home.tsx` | 交互 |
| `src/registry.ts` `src/types.ts` `src/store.ts` `src/lib/templates.ts` | 契约 |
| `src/styles.css` | 卡片/面板密度 |
| `server/sql_service/manifest.py` 及 http/wecom manifest | 与前端 schema 同步 |
| `test/uxContract.test.ts` `test/commands.test.ts` `test/outputShape.test.ts` `test/expression.test.ts` | 回归 |
| `docs/node-contract.md` `README.md` | 扩展说明 |
| `scripts/check-constants.sh` | 反特判门禁 |

预计不改：`worker/**`、`engine-core/decide.ts`、迁移 SQL、docker-compose。

---

## Tests / validation

自动化：

```bash
npm test                          # 含新增 uxContract / commands
npm run check                     # constants + tsc + test
node --test --experimental-strip-types test/uxContract.test.ts
cd server && .venv/bin/python test_flowdef.py
```

手测脚本（Task 19 前走一遍）：

1. 首页 → 空白流程 → 只见触发器 → `Tab` → 输入 `sql` → 回车，节点落下并打开 Inspector
2. SQL 写 `select 1 as token`，`⌘Enter` 试运行，下游企微 `/` → 选 SQL → 点 `token` 单元格 → 输入框是胶囊「SQL · token · 第 1 行」
3. 导出 JSON，content 里是 `{{ $.nodes.… }}`，能再导入
4. 单击节点只出 Inspector；双击出 NDV 输出
5. `Cmd+K` 能运行、能跳节点、能回首页
6. 关掉 API，整站 mock 仍能摆流程（胶囊、Tab、命令栏不依赖后端）
7. `localStorage.setItem('autoflow.chips','off')` 后退回朴素输入框

---

## Risks, tradeoffs, open questions

| 风险 | 处理 |
|---|---|
| contenteditable 胶囊在 IME / 中文输入法下抖 | 保留 `autoflow.chips=off`；Task 3 只把默认打开，不删朴素模式 |
| 后端 manifest 漏改 `x-ui.group` | Task 12 必须双边改；`check:flows` 用后端注册表 |
| 文案改引擎错误可能让 worker 测试绑死英文字符串 | 改 `test/expression.test.ts` / golden 时搜旧文案一并更新 |
| Inspector + 命令栏 + 运行面板同时开，小屏挤 | 命令栏是模态；不改成第三常驻栏 |
| `Tab` 与无障碍焦点冲突 | 仅当事件目标不是 input/textarea/contenteditable 时拦截 |
| 结构化引用入库（设计稿 §8）能让「来源失效」更好做 | **本轮不做**；失效检测继续用现有 `validateNode` 解析表达式 |

**Open questions（实现时用默认，不必再问）：**

1. NDV 参数 tab：保留但不默认（Task 7）
2. 节点 id：悬停可见，卡片默认隐藏（Task 8）
3. 引用存储：继续表达式字符串（YAGNI）

---

## 成功标准（对使用成本）

做完后，没读过 README 的同事应能：

1. 从空白模板 + `Tab` 在一分钟内摆出「SQL → 企微」
2. 全程不手打 `$.` 或节点 id
3. 分得清「右侧是改参数、底部是跑、双击是看数」
4. 新内部服务加节点：交 manifest，不提 PR 改 `HttpRequestForm` / `VarPicker`
)
