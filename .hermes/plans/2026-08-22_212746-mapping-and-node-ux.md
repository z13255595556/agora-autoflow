# 加工层点选化 + 节点体验补完计划

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.
>
> 前两份计划（`2026-08-22_153300-ux-cost-extensibility.md`、`2026-08-22_183726-full-page-ux.md`）以及已经落地的运行名实相符 / 同页路由 / 胶囊双击 / Cmd+K / Toast / 触发器原位替换 **不要重做**。本文件只补**还没写进那两份、或写了但没做成产品默认路径**的优化点。

**Goal:** 让「查数 → 裁一刀 → 发企微」中间不再逼人写表达式：取值面板能点出日报常用聚合，加工节点不再像编译器，加节点时先看见会用的、后看见专家项。

**Architecture:** 不新增节点种类，不换引擎，不把引用改存结构化 JSON。所有可视化选择继续编译成现有 `{{ $.… | filter }}`。`transform.map` / `list.operation` 降级为逃生口，主路径是 DataReferenceDrawer 的模式按钮 + 字段插入条。卡片摘要改走 manifest `x-summary`，禁止再往 `summary.ts` 加 `typeId` 分支。

**Tech Stack:** 现有 React 18 + Zustand + `@xyflow/react`。测试：`node --test --experimental-strip-types test/<file>.test.ts`，组件链导入必须带 `.ts` 后缀。改 `sql.query` / `http.request` / `notify.wecom` 展示字段时改 `server/sql_service/` 的 manifest，不要只改 `src/registry.ts`。

---

## 不要做

- 不 fork n8n / Activepieces，不换画布库
- 不加代码节点、飞书、邮件、Excel、Agent
- 不删 `transform.map` / `list.operation` / `variable.assign`（老流程还在用）
- 不把引用改成结构化 JSON 入库
- 不在 UI 里新写 `if (typeId === '…')` 画整块表单

---

## 当前缺口（有代码出处）

日报真正要的 6 件事，引擎过滤器已经有了（`src/lib/output.ts` `FILTERS`）：`at` / `column` / `table` / `count` / `sum` / `unique` / `join` / `sort` / `default`。

取值面板 `DataReferenceDrawer.tsx` TableRegion 只暴露了：单个值、整行、整列、表格、按条件、第一行、最后一行、完整结果、结果数量。**没有求和、去重、拼接、排序、缺省值。** 所以用户只能：

1. 去改 SQL（再跑一次 Hive），或
2. 打开「数据整形」，面对 placeholder `{ "vids": $.nodes.n1.output.rows.map(r, r.vid) }`（`src/registry.ts` `transform.map`），或
3. 在企微正文里手写 `| sum`

`list.operation` 只有 first/last/slice，和面板的 `first`/`last`/`at` 重复，却是一个独立节点。

`nodeSummary` 仍是 `switch (t.type)`（`src/lib/summary.ts`）。新节点必须改前端。

节点选择器把「数据整形 / 列表处理 / 变量赋值」和 SQL、企微平级排列（`NodePicker.tsx` + `CATEGORY_ORDER`）。

---

## 做完后用户应看到的

```
取值面板（表格）
  模式：单个值 | 整列 | 表格 | 汇总 | 按条件
  汇总里能点：行数、求和、去重个数、拼成一句话、排序后取第 1
  插入后仍是胶囊，双击才看见表达式

企微 / 模板正文
  字段下有「插入行数 / 插入表格 / 插入某列求和」，点完就是胶囊
  不再教人去加「模板转换」节点

加节点
  常用：SQL、企微、条件、循环、日期、HTTP
  更多：整形、列表、变量、汇合、结束
  整形的说明改成「自由写表达式（多数情况用取值面板即可）」

卡片摘要
  由 manifest 的 x-summary 拼出来，summary.ts 不再按 typeId 增长
```

---

## Track M · 取值面板补齐日报汇总

### Task M1: 扩展 ReferenceSelection 的汇总模式

**Objective:** 选择结果能编译成 `| sum` / `| unique | count` / `| join` / `| sort | first`，展示文案不含 `$.`。

**Files:**
- Modify: `src/lib/referenceSelection.ts`
- Test: `test/referenceSelection.test.ts`（已有 at/table/find 用例，往下加）
- Modify later: `src/lib/referenceFit.ts`（数字字段允许 `sum`/`count`）

**Step 1: 写失败测试**

在 `test/referenceSelection.test.ts` 追加：

```ts
test('汇总选择编译成过滤器，展示不含 $.', () => {
  const sum = {
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows',
    mode: 'sum' as const, column: 'dc', valueType: 'number' as const, label: 'dc · 求和',
  }
  assert.equal(compileReferenceSelection(sum), "{{ $.nodes.n2.output.rows | sum('dc') }}")
  assert.equal(selectionDisplayLabel(sum).includes('$.'), false)

  const uniq = {
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows',
    mode: 'uniqueCount' as const, column: 'vid', valueType: 'integer' as const, label: 'vid · 去重个数',
  }
  assert.match(compileReferenceSelection(uniq), /unique\('vid'\)/)
  assert.match(compileReferenceSelection(uniq), /count/)

  const joined = {
    sourceNodeId: 'n2', sourceLabel: 'SQL 查询', path: 'rows',
    mode: 'join' as const, column: 'name', separator: '、', valueType: 'string' as const, label: 'name · 拼接',
  }
  assert.match(compileReferenceSelection(joined), /column\('name'\)/)
  assert.match(compileReferenceSelection(joined), /join\('、'\)/)
})
```

**Step 2: 跑测试确认失败**

Run: `node --test --experimental-strip-types test/referenceSelection.test.ts`
Expected: FAIL — `mode: 'sum'` 不在联合类型里

**Step 3: 最小实现**

给 `ReferenceSelection` 增加：

```ts
| { sourceNodeId: string; sourceLabel: string; path: string; mode: 'sum'; column: string; valueType: 'number'; label: string }
| { sourceNodeId: string; sourceLabel: string; path: string; mode: 'uniqueCount'; column: string; valueType: 'integer'; label: string }
| { sourceNodeId: string; sourceLabel: string; path: string; mode: 'join'; column: string; separator: string; valueType: 'string'; label: string }
| { sourceNodeId: string; sourceLabel: string; path: string; mode: 'sortFirst'; column: string; direction: 'asc' | 'desc'; resultColumn?: string; valueType: JsonType; label: string }
```

`compileReferenceSelection`：

```ts
case 'sum':
  return `{{ ${base} | sum(${arg(selection.column)}) }}`
case 'uniqueCount':
  return `{{ ${base} | unique(${arg(selection.column)}) | count }}`
case 'join':
  return `{{ ${base} | column(${arg(selection.column)}) | join(${arg(selection.separator)}) }}`
case 'sortFirst':
  return `{{ ${base} | sort(${arg(selection.column)}, ${arg(selection.direction)}) | first(${selection.resultColumn ? arg(selection.resultColumn) : ''}) }}`
```

`selectionDisplayLabel` 继续用 `sourceLabel · label`，不要拼 path。

**Step 4: 再跑测试**

Run: `node --test --experimental-strip-types test/referenceSelection.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/referenceSelection.ts test/referenceSelection.test.ts
git commit -m "feat: compile sum/unique/join/sortFirst from visual selection"
```

---

### Task M2: 取值面板加「汇总」模式

**Objective:** 表格区域能点「求和 / 去重个数 / 拼接 / 排序取第 1」，不必手写过滤器。

**Files:**
- Modify: `src/components/DataReferenceDrawer.tsx` 的 `TableRegion`（约 345–427 行）
- Modify: `src/styles.css`（若需 `.dataref__agg`）

**Step 1: 模式条增加「汇总」**

把

```ts
;([['cell', '单个值'], ['row', '整行'], ['column', '整列'], ['table', '表格'], ['find', '按条件']] as const)
```

改成：

```ts
;([['cell', '单个值'], ['column', '整列'], ['table', '表格'], ['agg', '汇总'], ['find', '按条件']] as const)
```

「整行」并进单元格模式里的「选择第 N 行」即可，不要六个平级页签。

**Step 2: 画汇总区**

`mode === 'agg'` 时渲染：

- 列下拉（默认第一列数字列，否则第一列）
- 四个按钮：`求和` `去重个数` `顿号拼接` `按此列最大取第 1 行`
- 点按钮 `onChoose` 对应 M1 的 selection，`sample` 用当前 `table.sampleRows` 在前端算一个预览（求和就 reduce，算错也没关系，正式值仍走引擎）

**Step 3: 手测**

打开日报模板，点企微正文 `/`，进 SQL 的表格，切到汇总，点求和。胶囊应显示「SQL 查询 · dc · 求和」，底层是 `| sum('dc')`。

**Step 4: Commit**

```bash
git add src/components/DataReferenceDrawer.tsx src/styles.css
git commit -m "feat: visual aggregate actions in data reference drawer"
```

---

### Task M3: 文本字段的快捷插入条

**Objective:** 企微正文、模板转换、结束节点的结果框下面，有「插入行数 / 插入表格 / 插入该列求和」，不经过取值面板也能完成 80% 日报。

**Files:**
- Create: `src/lib/insertPresets.ts`
- Test: `test/insertPresets.test.ts`
- Modify: `src/components/SchemaForm.tsx`（`inserters` 已存在，给 `message` 之外加 `data-presets`）
- Modify: `server/sql_service/wecom.py` 的 content 字段 `x-ui.inserters`（后端会覆盖 `notify.wecom`）
- Modify: `src/registry.ts` 里 `transform.template` / `flow.end` 的 `x-ui`

**Step 1: 失败测试**

```ts
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { presetSelection } from '../src/lib/insertPresets.ts'

test('行数预设指向最近上游表格的 count', () => {
  const sel = presetSelection({
    kind: 'count',
    sourceNodeId: 'n2',
    sourceLabel: 'SQL 查询',
    container: 'rows',
  })
  assert.equal(sel.mode, 'count')
  assert.equal(sel.sourceNodeId, 'n2')
})
```

**Step 2: 跑测试确认失败**

Run: `node --test --experimental-strip-types test/insertPresets.test.ts`
Expected: FAIL — 模块不存在

**Step 3: 实现 `presetSelection`**

```ts
export type PresetKind = 'count' | 'table' | 'sum'

export function presetSelection(input: {
  kind: PresetKind
  sourceNodeId: string
  sourceLabel: string
  container: string
  column?: string
}): ReferenceSelection { /* 复用 M1 的联合类型 */ }
```

上游从哪来：`upstreamNodes(nodeId)` 里第一个带表格形态的节点（`describeOutputShape` / `probedColumns`）。没有上游就禁用按钮，title 写「先连一个 SQL」。

**Step 4: SchemaForm 里画条**

当 `ui.inserters` 包含 `'data'`（或 `'message'` 已有的那条旁边）时，渲染三个小按钮，`onChange` 在当前值末尾追加 `compileReferenceSelection(...)`。已有胶囊字段会 `renderTokens`。

**Step 5: 测试 + commit**

Run: `node --test --experimental-strip-types test/insertPresets.test.ts && npx tsc -b --pretty false`
```bash
git add src/lib/insertPresets.ts test/insertPresets.test.ts src/components/SchemaForm.tsx src/registry.ts server/sql_service/wecom.py
git commit -m "feat: one-click insert row count/table/sum under message fields"
```

---

## Track N · 加工节点降级，不再像编译器

### Task N1: 改掉整形节点的 CEL 占位符和描述

**Objective:** 打开「数据整形」不再看见 `.map(r, r.vid)`。

**Files:**
- Modify: `src/registry.ts` `transform.map`（约 509–528 行）

把 description / placeholder 改成：

```
description: '多数取值请在字段里点「/」选。这里只留给取值面板做不到的自由表达式。'
'x-ui': { widget: 'code', rows: 6, placeholder: '/ 选择上游数据，或双击胶囊改表达式' }
```

不要在 placeholder 里放 `$.`。

**Commit:** `git commit -m "fix: stop teaching CEL in transform.map placeholder"`

---

### Task N2: 节点选择器分「常用 / 更多」

**Objective:** 加节点时先看见 SQL、企微、条件、循环、日期、HTTP；整形 / 列表 / 变量 / 汇合 / 结束默认折在「更多」。

**Files:**
- Modify: `src/types.ts`（`NodeType` 增加可选 `rank?: 'common' | 'more'`，或用现有字段）
- Modify: `src/registry.ts` 给每个节点标 rank
- Modify: `src/components/NodePicker.tsx` 的 `grouped` useMemo（约 86–107 行）
- Test: 不必上组件测试；加一个纯函数

**推荐实现（少改类型）：** 在 `src/lib/nodeRank.ts`：

```ts
export const MORE_TYPES = new Set([
  'transform.map', 'list.operation', 'variable.assign', 'flow.merge', 'flow.end',
])
export function isMoreNode(type: string): boolean {
  return MORE_TYPES.has(type)
}
```

NodePicker：无搜索词时，常用按原分类排；底部一节 `<details>`「更多节点」。有搜索词时不过滤，避免专家项找不到。

**不要**按 `typeId` 在 JSX 里写 6 个 if。只问 `isMoreNode(t.type)`。

**Commit:** `git commit -m "feat: demote expert nodes behind More in picker"`

---

### Task N3: 列表处理节点提示去取值面板

**Objective:** 不删 `list.operation`，但打开它时告诉用户「取第一项 / 第 N 行请在引用字段里点选」。

**Files:**
- Modify: `src/registry.ts` `list.operation` 的 description
- Modify: `src/components/SchemaForm.tsx` —— 若字段 `x-ui.hint` 有值，画一行 `.field__hint`

给 `items` 加：

```
'x-ui': { widget: 'text', placeholder: '/ 选择上游表格或列表', hint: '取第几行、整列、求和，在弹出的取值面板里点，不必先加本节点。' }
```

通用 hint，别写 `if (typeId === 'list.operation')`。

**Commit:** `git commit -m "feat: schema hint that list ops live in the picker"`

---

### Task N4: 变量赋值输出继续 spread，摘要用人话

**Objective:** 卡片写「customerId、date」而不是「设置 2 个变量」。

**Files:**
- Modify: `src/lib/summary.ts` `variable.assign` 分支（本任务可以暂时改 switch；N5 会拆掉）
- Test: 若有 `test/summary` 就加，没有就在 `test/flowCardMeta.test.ts` 旁建 `test/summary.test.ts`

```ts
test('变量卡片列出名字', () => {
  assert.match(
    nodeSummary(NODE_TYPE_MAP.get('variable.assign')!, { values: { customerId: '1', date: '2' } }),
    /customerId/,
  )
})
```

**Commit:** `git commit -m "feat: show assigned variable names on the card"`

---

## Track S · 摘要去 typeId

### Task S1: 用 `x-summary` 声明卡片怎么拼

**Objective:** 新节点只改 manifest，不再改 `summary.ts` 的 switch。

**Files:**
- Create: `src/lib/schemaSummary.ts`
- Test: `test/schemaSummary.test.ts`
- Modify: `src/lib/summary.ts` 先走 schema，再 fallback 现有 switch（兼容没标的节点）
- Modify: `src/registry.ts` 给 `http.request` / `transform.template` / `list.operation` 加 `x-summary`
- `sql.query` / `notify.wecom` 加在 **后端 manifest**（`server/sql_service/`），否则生产环境前端标会被覆盖

约定（写进 `docs/node-contract.md`）：

```
input['x-summary'] = {
  whenEmpty: '未写 SQL',          // 所有 listed 字段都空
  fields: ['engine', 'sql'],      // 按顺序，空的跳过
  join: ' · ',
  clip: 34
}
```

测试：

```ts
test('http 摘要是 METHOD + URL，没有 typeId', () => {
  const t = { type: 'http.request', input: {
    'x-summary': { fields: ['method', 'url'], join: ' ', whenEmpty: '未填 URL' },
    properties: {
      method: { default: 'GET' },
      url: { title: 'URL' },
    },
  } }
  assert.equal(schemaSummary(t as any, { method: 'POST', url: 'https://x' }), 'POST https://x')
})
```

实现时 `nodeSummary` 开头：

```ts
if (t.input['x-summary']) return schemaSummary(t, params)
```

特殊逻辑（SQL 跳过注释行、条件行、日程描述）**暂时留在 switch**，不要为了纯洁把 `describeSchedule` 硬塞进通用拼接。S1 只吃「字段拼一句」的节点。

**Commit:** `git commit -m "feat: manifest-driven card summaries"`

---

## Track P · 加节点与画布摩擦

### Task P1: `/` 先选上游节点再选字段

**Objective:** 光标后打 `/`，第一屏是「SQL 查询 / 日期计算 / 流程入参」，点完才进该源的字段。现在 `VarPicker` 一上来平铺所有 path。

**Files:**
- Modify: `src/lib/slash.ts` `filterSlashVars` 或新建 `src/lib/slashGroups.ts`
- Test: `test/slash.test.ts`（已有则追加）
- Modify: `src/components/VarPicker.tsx`

```ts
export function groupSlashVars(vars: VarEntry[]): { group: string; items: VarEntry[] }[] {
  const map = new Map<string, VarEntry[]>()
  for (const v of vars) {
    const key = v.group.split('·')[0].trim() // 「SQL 查询 (n2)」→ 仍按 group 字段
    map.set(v.group, [...(map.get(v.group) ?? []), v])
  }
  return [...map].map(([group, items]) => ({ group, items }))
}
```

VarPicker：`query` 为空时只列出 group 行；选中 group 或开始输入后才列出条目。条目继续用 `displayLabel`，禁止画 `item.path`。

**Commit:** `git commit -m "feat: slash picker is node-first then field"`

---

### Task P2: 循环节点的 items 默认打开取值面板

**Objective:** 点「遍历对象」不要先出现一个空文本框等人打 `/`。

**Files:**
- Modify: `src/registry.ts` `flow.foreach` 的 `items`：`'x-ui': { widget: 'text', openPicker: 'on-focus' }`
- Modify: `src/components/RefField.tsx`：若 `openPickerOnFocus` 且值为空，focus 时调现有 `openReferencePicker`

只在空值时自动开，避免改已有引用时被抢走焦点。

**Commit:** `git commit -m "feat: empty foreach items opens the mapper on focus"`

---

### Task P3: 节点卡可点名称重命名

**Objective:** 双击名称改「SQL 查询」为「昨日活跃」，不必进 Inspector 找标题。

**Files:**
- Modify: `src/components/FlowNodeView.tsx` `.node__name`
- Store 已有改 label 的入口则复用；没有就在 `store.ts` 加 `renameNode(id, label)`

双击名称：`stopPropagation`，不要打开 NDV（NDV 是双击卡片空白/图标）。输入框 `nodrag`，Enter / blur 提交，空串回退原名。

**Commit:** `git commit -m "feat: rename node from the card title"`

---

### Task P4: 未连线的出口加号与接线点间距回归用例

**Objective:** 多出口加号偏移写成常量，避免以后再被单出口的 `right: -34px` 覆盖回去。

**Files:**
- Modify: `src/styles.css` `.node__plus--port`（已在 `left: 100%; margin-left: 28px`）
- 若有 visual/css 测试就锁这两行；没有则在 `docs/node-contract.md` 加一条「多出口加号不得复用 `.node__plus` 的 right」

本任务只是把已修的布局钉死，不要再调数字除非手测又叠上。

---

## Track E · 报错与预览人话

### Task E1: 运行期缺值错误用人话替换路径

**Objective:** 企微失败不要只丢 `$.nodes.n2.output.rows[0].token 取不到`。

**Files:**
- Create: `src/lib/humanizeError.ts`
- Test: `test/humanizeError.test.ts`
- Modify: `src/lib/engine.ts` 抛错处，或只在 **UI 展示层**（`RunPanel` / `FlowNodeView` / `Toolbar` 问题列表）包一层，**不要改引擎字符串**（Python 对拍会碎）

```ts
export function humanizeError(message: string, nodes: { id: string; data: { label: string } }[]): string {
  return message.replace(/\$\.nodes\.([A-Za-z0-9_]+)/g, (_, id) => {
    const label = nodes.find((n) => n.id === id)?.data.label
    return label ?? id
  }).replace(/\$\.trigger\./g, '入参 · ').replace(/\$\.loop\./g, '循环 · ')
}
```

测试：`assert.equal(humanizeError('{{ $.nodes.n2.output.rows[0].x }} 取不到', [{ id: 'n2', data: { label: 'SQL 查询' } }]).includes('$.'), false)`

展示层三处都走这个函数：`RunPanel` 步骤错误、`Toolbar` 问题列表、节点卡 `title`。

**Commit:** `git commit -m "feat: humanize $. paths only in UI error text"`

---

### Task E2: 取值面板「还没跑过」时强调试运行，不强调 JSON

**Objective:** `shape.unknown` 的文案改成「先试运行这个 SQL，才能点选列」，按钮保持现有 `试运行并获取数据`。

只改 `DataReferenceDrawer.tsx` 里 `.dataref__runbox` 的两行字。不要为 SQL 写 typeId 分支——`shape.typeId` 已用于是否显示按钮，保持原条件。

**Commit:** `git commit -m "copy: unknown shape asks for a test run, not a schema"`

---

## Track T · 模板

### Task T1: 日报模板的企微正文改成胶囊友好的预设

**Objective:** 新建「定时查询 SQL」后，企微正文里是「共 {{ count }} 条 + 表格」，打开即胶囊，不必先懂 `| table()`。

**Files:**
- Modify: `src/lib/templates.ts` `scheduled-sql` 的 `content`
- Test: `test/templates.test.ts` 已有 recipe 断言，追加：

```ts
test('日报模板正文不含手写教学用的 $. 展示', () => {
  const flow = TEMPLATES.find((t) => t.key === 'scheduled-sql')!.build()
  const wecom = flow.nodes.find((n) => n.type === 'notify.wecom')!
  // 底层仍是表达式，这没问题；不要再附一段「请把 n2 改成你的节点 id」
  assert.equal(String(wecom.params.content).includes('请把'), false)
})
```

content 可保持现有 `rowCount` + `table()` —— 打开字段就会变成胶囊。不要改成空正文。

**Commit:** `git commit -m "chore: keep daily template insertable as chips"`

---

### Task T2: 加一条「手动查数发群」recipe

**Objective:** 不是每个人都要定时。空白「手动触发」后面仍要自己连 SQL。

**Files:**
- Modify: `src/lib/templates.ts`
- Test: `test/templates.test.ts`（已有「recipe 至少两个节点且有边」会自动覆盖）

复制 `scheduled-sql`，trigger 改 `manual`，名字「查数发到群」。`kind: 'recipe'`。不要再加第三条除非真有 Webhook 日报。

**Commit:** `git commit -m "feat: manual SQL-to-WeCom recipe"`

---

## 验证（整轨做完后）

```bash
npx tsc -b --pretty false
npm test
# 有改 wecom/sql manifest 时：
server/.venv/bin/python -m pytest server/test_flowdef.py -q   # 若该文件存在；否则跑仓库里现有的 python 测试入口
```

手测一条路径（必须过，比单测更重要）：

1. 首页 → 定时查询 SQL
2. 填一句 `select 1 as dc`（或真实 SQL）
3. 试运行 SQL
4. 打开企微正文，点「插入表格」或 `/` → 汇总 → 求和
5. 顶栏运行，预览里是数字/表，不是路径
6. 画布上条件分支的真/假加号仍不压接线点
7. 加节点列表里「数据整形」在「更多」里

---

## 建议顺序

M1 → M2 → M3 → N1 → N2 → T1 → T2 → P1 → P2 → P3 → S1 → N3 → N4 → E1 → E2 → P4

M 轨是体感最大的一刀：加工节点「变强」靠的是面板，不是加种类。

---

## 风险

- 引擎 `sum` / `unique` 的参数形状必须和 `compileReferenceSelection` 一字不差。先读 `src/lib/engine.ts` 里这两个过滤器的实现再写编译，不要猜。
- `notify.wecom` 前端 registry 改了会被后端覆盖。inserters 一定改 Python manifest。
- `humanizeError` 只用于 UI。改 `engine.ts` 抛错原文会让 TS/Python 对拍测试失败。
- NodePicker「更多」用 `<details>`，键盘上下移动要能进这一节，否则搜索还能找、不搜索用键盘的人会丢节点。

---

## 实现时的默认决策（不要再问）

1. 不删任何现有节点类型。
2. 汇总默认分隔符是中文顿号 `、`（和现有 `join` 默认一致）。
3. 「整行」不再占用顶级页签。
4. 卡片摘要：能 schema 化的就 schema 化；SQL / 条件 / 日程保持专用函数。
5. 提交信息用英文 `feat:` / `fix:`，和现有习惯一致。
