import type { Edge } from '@xyflow/react'
import type { FlowRun, JsonSchema, OutputUiHint } from '../types'
import type { FNode } from '../store'
// 值导入带 .ts 扩展名，是为了让 `node --test --experimental-strip-types` 能直接
// 跑这个文件：Node 的 ESM 解析器不补扩展名，而 tsconfig 早就开了
// allowImportingTsExtensions，Vite 也认。仅类型的导入会被剥掉，不受影响。
// 规矩：**想被 node --test 跑的文件，它的值导入链上每一环都要带扩展名。**
import { NODE_TYPE_MAP, portsOf } from '../registry.ts'
import { extractRows, probedColumns, probedContainer } from './output.ts'
import { hasOrderBy } from './placeholders.ts'
import { isSensitiveHeaderName, redactOutput } from './secrets.ts'

/**
 * 统一的输出描述。
 *
 * 取值面板**永远不按 typeId 分支** —— 它只读这里给出的形态。加一种节点不需要
 * 再写一套面板；节点只声明输出结构，界面由结构推出来。
 *
 * 依赖方向是硬约束：
 *
 *     outputShape → output / registry / secrets / placeholders / types(仅类型)
 *     outputShape ✗ vars / engine / 任何组件
 *
 * 那个 ✗ 是承重的：validateNode（在 vars.ts）要用这里的静态版做类型检查，
 * 这里再去 import engine 就成了 vars → outputShape → engine → vars 的环。
 * latestOutput 因此住在 output.ts 而不是 engine.ts。
 */

// ---------------------------------------------------------------- 类型

/** 五种数据形态。面板按它选界面 */
export type ShapeKind = 'scalar' | 'object' | 'array' | 'table' | 'status'

export type JsonType = 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array' | 'unknown'

/**
 * 值是从哪儿来的。
 *
 * 顺序**不是**「最近一次运行优先」：pin 压过 run，和 latestOutput / ctxFromRun
 * 一致。反过来的话面板预览的值和 resolveTemplate 执行的值会是两份数据。
 */
export type ValueSource = 'pin' | 'run' | 'probe' | 'schema'

export interface FieldDesc {
  /** 拼在 `$.nodes.<id>.output.` 之后就是完整引用。**恒为 lookupPath 解得开的形状** */
  path: string
  /** 面板上的短名：schema 的中文 title 优先 */
  label: string
  /** 面包屑全名：'响应正文 · user · name'。胶囊 tooltip 和报错用 */
  fullLabel: string
  valueType: JsonType
  /** 已脱敏、已截断的样例值。只在 known 为真时有意义 */
  sample?: unknown
  /** true = 这个值我们真见过；false = 只是声明或探测出来的形状 */
  known: boolean
  sensitive: boolean
  /** 这个字段本身还能继续下钻，值是它的 region path */
  regionPath?: string
}

export interface TableDesc {
  /** 行容器字段名：'rows' / 'hits' / …；顶层就是数组时为 '' */
  container: string
  columns: Array<{ name: string; label: string; type: JsonType; sensitive: boolean }>
  /** 预览行，已脱敏已截断。probe / schema 来源时可能为空 */
  sampleRows: Array<Record<string, unknown>>
  rowCount?: number
  /** 运行结果只取回了部分行；此时 last 只是当前样例的末行。 */
  truncated?: boolean
  /** SQL 没有 ORDER BY —— 「第 N 行」不稳定，「最后一行」没有意义 */
  orderUnstable?: boolean
  /** 行的显示名，按下标对齐。flow.merge 用它显示分支来源节点名 */
  rowLabels?: string[]
}

export interface RegionDesc {
  /** 相对 output 的路径前缀，顶层为 ''。面包屑和"定位到当前引用"靠它 */
  path: string
  label: string
  kind: ShapeKind
  /** 默认折叠：运行信息、响应头 */
  collapsed?: boolean
  fields: FieldDesc[]
  regions: RegionDesc[]
  table?: TableDesc
  array?: { itemType: JsonType; sampleItems: unknown[]; length?: number }
}

export interface OutputShape {
  nodeId: string
  nodeLabel: string
  typeId: string
  root: RegionDesc
  source: ValueSource
  /** 值的时刻。预览上标「最近一次运行 14:03」，免得被当成实时值 */
  at?: number
  /** 最近一次样例是否来自真实后端执行；false 可能是本地 mock。 */
  live?: boolean
  /** 完全不知道会返回什么 —— 走空状态，**不要猜字段** */
  unknown: boolean
  /** 声明支持结构探测 —— 决定显不显示「获取字段」 */
  probeable: boolean
  /** 不作为上游数据源出现 */
  hidden: boolean
}

export interface DescribeCtx {
  run?: FlowRun | null
  pinData?: Record<string, unknown>
  /** 探测时真跑回来的那一行。只在内存里，绝不进流程定义 */
  probeSample?: unknown
  /** flow.merge 要按入边顺序给分支起名；别的节点用不到 */
  nodes?: FNode[]
  edges?: Edge[]
}

// ---------------------------------------------------------------- 名字表

/**
 * 运行元数据的字段名。
 *
 * 刻意做成前端的名字表而不是 schema 注解：sql.query / notify.wecom / http.request
 * 的 manifest 由后端整份下发（registry.applyBackendNodes 全量覆盖），往 registry.ts
 * 里加的注解在后端一上线就没了 —— 而且只在线上没，本地永远测不出来。
 * 名字表在前端，覆盖不掉。
 */
const RUN_META_KEYS = new Set([
  'runId', 'startedAt', 'scheduledFor', 'firedAt',       // 触发器
  'jobId', 'renderedSql', 'truncated', 'rowCount',       // sql.query
  'status', 'attempts', 'url',                           // http.request
  'sent', 'bytes', 'target',                             // notify.wecom
  'okCount', 'failCount',                                // flow.foreach
  'logs', 'durationMs',                                  // code.python（manifest 里也标了 x-output-ui，这里兜底）
])

/** 结构性容器，用户不该看见 —— columns 的内容已经由表头承载了 */
const HIDDEN_KEYS = new Set(['columns'])

/** 默认折叠的高级区域 */
const ADVANCED_KEYS = new Set(['headers'])

/** 一屏之内看得完的预览行数 */
export const PREVIEW_ROWS = 20
/** 单元格里塞得下的字符数 */
const PREVIEW_CELL_CHARS = 200

// ---------------------------------------------------------------- 工具

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

function jsonTypeOf(value: unknown): JsonType {
  if (value === undefined || value === null) return 'unknown'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return 'string'
}

function clipCell(v: unknown): unknown {
  if (typeof v !== 'string') return v
  return v.length > PREVIEW_CELL_CHARS ? `${v.slice(0, PREVIEW_CELL_CHARS)}…` : v
}

const uiOf = (schema: JsonSchema | undefined): OutputUiHint => schema?.['x-output-ui'] ?? {}

/**
 * 一段值属于哪种形态。
 *
 * 'status' **永不从值推断** —— 只由字段名/元数据指定（见 classifyRegion）。
 * 否则同一个节点会随运行结果在两套界面之间来回闪。
 */
function classifyValue(value: unknown): ShapeKind {
  if (extractRows(value)) return 'table'
  if (Array.isArray(value)) return isRecord(value[0]) ? 'table' : 'array'
  if (isRecord(value)) return 'object'
  return 'scalar'
}

// ---------------------------------------------------------------- 入口

/**
 * 只用**会被持久化**的东西算形态：registry schema + node.data.probedOutput + params。
 *
 * validateNode 只能用这个。用了运行记录的话，「这条流程合不合法」会随运行历史
 * 被清空而漂移 —— 清一下运行列表，能跑的流程就变成校验不过的了。
 */
export function describeOutputStatic(node: FNode): OutputShape {
  return describeOutput(node)
}

/** 静态形态叠加真实值。取值面板和预览用这个。 */
export function describeOutput(node: FNode, ctx: DescribeCtx = {}): OutputShape {
  const typeId = node.data.typeId
  const t = NODE_TYPE_MAP.get(typeId)
  const nodeLabel = node.data.label

  if (!t) {
    return {
      nodeId: node.id, nodeLabel, typeId,
      root: { path: '', label: nodeLabel, kind: 'object', fields: [], regions: [] },
      source: 'schema', unknown: true, probeable: false, hidden: true,
    }
  }

  const rootUi = uiOf(t.output)
  // ports 为空 = 没有出口 = 连不出去 = 永远不可能是别人的上游。
  // flow.end / canvas.note 是这样，不需要额外注解。
  // notify.wecom **不**在此列：它有出口，sent / bytes / target 下游引用得到
  //（"没发出去就走另一条分支"要靠它）。
  const hidden = Boolean(t.visualOnly) || portsOf(t).length === 0 || Boolean(rootUi.notASource)
  const probeable = t.output['x-dynamic'] === 'probe'

  // 取值：pin > run > 探测样例 > 没有。
  //
  // 这里刻意**不**调 latestOutput，虽然 pin 优先的规则是一样的：那个函数不看
  // 步骤成不成功，而 ctxFromRun 只收成功的步骤。面板要对齐的是 **ctxFromRun**
  // —— 引用在运行期是它解析的。拿失败步骤的输出画一张表给用户挑，挑出来的
  // 引用运行时会解析成空，那就是在骗人。
  //
  // （latestOutput 的宽松是 NDV 输出栏要的：跑失败了也得让人看见回了什么。
  //   两个语义都对，只是服务对象不同，别去"统一"它们。）
  let value: unknown
  let source: ValueSource = 'schema'
  let at: number | undefined
  let live: boolean | undefined
  const pinData = ctx.pinData ?? {}
  if (Object.prototype.hasOwnProperty.call(pinData, node.id)) {
    value = pinData[node.id]
    source = 'pin'
  } else {
    const step = ctx.run?.steps[node.id]?.at(-1)
    if (step?.status === 'success') {
      value = step.output
      source = 'run'
      at = step.startedAt
      live = step.live
    } else if (ctx.probeSample !== undefined) {
      value = ctx.probeSample
      source = 'probe'
    }
  }
  // 脱敏在这里做一次，往下所有 sample 都是从这份来的 —— OutputShape 结构上
  // 就不可能携带未脱敏的值，下游组件想漏也漏不出去
  value = redactOutput(typeId, value)

  const probed = node.data.probedOutput
  const hasProbed = !!probed && Object.keys(probed).length > 0
  const unknown = source === 'schema' && !!t.output['x-dynamic'] && !hasProbed

  const root = buildRegion({
    path: '',
    label: nodeLabel,
    schema: t.output,
    value,
    node,
    typeId,
    probed,
    depth: 0,
    ctx,
  })

  return { nodeId: node.id, nodeLabel, typeId, root, source, at, live, unknown, probeable, hidden }
}

// ---------------------------------------------------------------- 区域构建

interface BuildArgs {
  path: string
  label: string
  schema?: JsonSchema
  value: unknown
  /** 上一层的值。表格要从它身上取后端声明的 columns 类型 */
  parentValue?: unknown
  node: FNode
  typeId: string
  probed?: Record<string, JsonSchema>
  depth: number
  ctx: DescribeCtx
}

/** 和 toResponseFields 同一个深度预算 */
const MAX_DEPTH = 3

function buildRegion(a: BuildArgs): RegionDesc {
  const { path, label, schema, value, node, probed, depth, ctx } = a

  // 表格 / 数组分支 —— 只在**这一层本身**就是那批行时成立。
  //
  // 刻意不在根上用 extractRows 短路：SQL 节点的 output 里既有 rows 也有
  // rowCount / jobId / renderedSql，根一旦被判成表格，那些字段就全没了。
  // 让 rows 当子区域，根仍是对象，运行元数据才有地方待。
  const table = buildTable(a)
  if (table) {
    return { path, label, kind: 'table', fields: [], regions: [], table }
  }

  if (Array.isArray(value)) {
    return {
      path, label, kind: 'array', fields: [], regions: [],
      array: {
        itemType: jsonTypeOf(value[0]),
        sampleItems: value.slice(0, PREVIEW_ROWS).map(clipCell),
        length: value.length,
      },
    }
  }

  // 对象 / 声明式：字段来源是三份的并集，真实值优先
  const keys = collectKeys(a)
  const fields: FieldDesc[] = []
  const regions: RegionDesc[] = []
  let runMetaCount = 0

  for (const key of keys) {
    if (HIDDEN_KEYS.has(key)) continue
    const sub = schema?.properties?.[key]
    const ui = uiOf(sub)
    if (ui.group === 'hidden') continue

    const childPath = path ? `${path}.${key}` : key
    const childValue = isRecord(value) ? value[key] : undefined
    const known = isRecord(value) && key in value

    // spread：容器不画，内容当一级字段。variable.assign 的 values
    if (ui.spread && depth < MAX_DEPTH) {
      const inner = buildRegion({ ...a, path: childPath, label: ui.label ?? key, schema: sub, value: childValue, depth: depth + 1 })
      fields.push(...inner.fields)
      regions.push(...inner.regions)
      continue
    }

    if (RUN_META_KEYS.has(key)) runMetaCount += 1

    const declaredType = (sub?.type as JsonType | undefined)
    const valueType = known ? jsonTypeOf(childValue) : (declaredType ?? 'unknown')
    const fieldLabel = ui.label ?? sub?.title ?? key
    // 按**具体头名**判，不是"响应头里的一律算敏感" —— content-type 是正当的
    // 引用对象，set-cookie 不是。值那边 redactOutput 已经换成 [REDACTED] 了，
    // 这个标记决定的是能不能被选中和进搜索索引
    const sensitive = Boolean(ui.secret) || (path === 'headers' && isSensitiveHeaderName(key))

    const canDescend =
      depth < MAX_DEPTH && (valueType === 'object' || valueType === 'array' || hasProbedChildren(probed, childPath))

    if (canDescend) {
      const sourceLabels = ui.itemLabelFrom === 'sourceNodeName' ? branchLabels(node, ctx) : undefined
      const region = buildRegion({
        ...a,
        path: childPath,
        label: fieldLabel,
        schema: sub,
        value: childValue,
        parentValue: value,
        depth: depth + 1,
      })
      if (sourceLabels && region.table) region.table.rowLabels = sourceLabels
      if (ADVANCED_KEYS.has(key) || ui.group === 'advanced' || ui.group === 'run') region.collapsed = true
      regions.push(region)
    }

    fields.push({
      path: childPath,
      label: fieldLabel,
      fullLabel: path ? `${label} · ${fieldLabel}` : fieldLabel,
      valueType,
      sample: known ? clipCell(childValue) : undefined,
      known,
      sensitive,
      regionPath: canDescend ? childPath : undefined,
    })
  }

  // 全是运行元数据 → 整个区域是「运行信息」，默认折叠。
  // notify.wecom（sent / bytes / target）正好落在这里，零注解。
  const kind: ShapeKind =
    fields.length > 0 && runMetaCount === fields.length ? 'status'
      : isRecord(value) || schema?.properties ? 'object'
        : classifyValue(value)

  return { path, label, kind, collapsed: kind === 'status' || undefined, fields, regions }
}

/** 这一层能看见哪些 key：真实值 > probedOutput > schema 声明，按此顺序去重 */
function collectKeys({ schema, value, probed, path }: BuildArgs): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (k: string) => {
    if (!IDENT_RE.test(k) || seen.has(k)) return
    seen.add(k)
    out.push(k)
  }
  if (isRecord(value)) Object.keys(value).forEach(push)
  // probedOutput 的 key 是完整点路径（body.user.name）；只取本层那一段
  for (const key of Object.keys(probed ?? {})) {
    const rest = path ? (key.startsWith(`${path}.`) ? key.slice(path.length + 1) : null) : key
    if (rest === null) continue
    const head = rest.split(/[.[]/)[0]
    if (head) push(head)
  }
  Object.keys(schema?.properties ?? {}).forEach(push)
  return out
}

const hasProbedChildren = (probed: Record<string, JsonSchema> | undefined, path: string): boolean =>
  Object.keys(probed ?? {}).some((k) => k.startsWith(`${path}.`) || k.startsWith(`${path}[`))

/**
 * 表格描述。两条路都要认：
 *   - 这一层本身就是对象数组 → 从值里取行和列
 *   - 只学到列名（没跑过、或只探测过）→ probedOutput 里的 `<容器>[].<列>`
 */
function buildTable(a: BuildArgs): TableDesc | undefined {
  const { path, value, parentValue, node, typeId, probed } = a

  if (Array.isArray(value) && isRecord(value[0])) {
    const rows = value as Array<Record<string, unknown>>
    const names = [...new Set(rows.flatMap((r) => (isRecord(r) ? Object.keys(r) : [])))]
    // 后端每次 poll 都回的 columns 带真实 SQL 类型，比对着值猜准得多。
    // 它是 rows 的**兄弟**字段，所以要从上一层拿
    const declared = declaredColumnTypes(parentValue)
    return {
      container: path,
      columns: names.map((name) => ({
        name,
        label: name,
        type: declared.get(name) ?? jsonTypeOf(rows.find((r) => r?.[name] !== undefined)?.[name]),
        sensitive: typeId === 'http.request' && path.startsWith('headers'),
      })),
      // 先切片再映射：rows 声明了 x-large、limit 上限十万，
      // 而面板的搜索框每敲一下都会重算一次
      sampleRows: rows.slice(0, PREVIEW_ROWS).map((r) =>
        Object.fromEntries(names.map((n) => [n, clipCell(r?.[n])])),
      ),
      rowCount: rows.length,
      truncated: Boolean(isRecord(parentValue) && parentValue.truncated),
      orderUnstable: orderUnstableFor(node, typeId),
    }
  }

  // 没有真实值，但学到了列名。只在这一层正好是那个容器时才认
  if (!probed || !path || probedContainer(probed) !== path) return undefined
  const cols = probedColumns(probed)
  if (!cols.length) return undefined
  return {
    container: path,
    columns: cols.map((c) => ({ name: c.name, label: c.name, type: (c.type as JsonType) ?? 'unknown', sensitive: false })),
    sampleRows: [],
    orderUnstable: orderUnstableFor(node, typeId),
  }
}

/** 后端每次 poll 都回的 columns 带真实 SQL 类型，比对值猜准得多 */
function declaredColumnTypes(value: unknown): Map<string, JsonType> {
  const out = new Map<string, JsonType>()
  if (!isRecord(value) || !Array.isArray(value.columns)) return out
  for (const c of value.columns) {
    if (!isRecord(c) || typeof c.name !== 'string') continue
    out.set(c.name, sqlTypeToJson(String(c.type ?? '')))
  }
  return out
}

/** 只要够用来决定「这一列能不能用大于小于」就行，不求精确 */
function sqlTypeToJson(t: string): JsonType {
  const s = t.toLowerCase()
  if (/int|long|short|byte/.test(s)) return 'integer'
  if (/double|float|decimal|numeric|real/.test(s)) return 'number'
  if (/bool/.test(s)) return 'boolean'
  return 'string'
}

function orderUnstableFor(node: FNode, typeId: string): boolean | undefined {
  if (typeId !== 'sql.query') return undefined
  return !hasOrderBy(String(node.data.params.sql ?? ''))
}

/**
 * flow.merge 的分支名，按**入边顺序**。
 *
 * 只有在 engine 那边把 flatMap 改成 map 之后这才是对的 —— flatMap 会挤掉没跑
 * 的分支，下标和入边就对不上，名字会贴到别人的数据上。
 */
function branchLabels(node: FNode, ctx: DescribeCtx): string[] | undefined {
  if (!ctx.edges || !ctx.nodes) return undefined
  return ctx.edges
    .filter((e) => e.target === node.id)
    .map((e) => ctx.nodes!.find((n) => n.id === e.source)?.data.label ?? e.source)
}

// ---------------------------------------------------------------- 拍平（给搜索用）

export interface FlatEntry {
  path: string
  label: string
  fullLabel: string
  valueType: JsonType
  sample?: unknown
  known: boolean
}

/**
 * 把一份形态拍平成可搜索的条目。
 *
 * 下钻是发现道，搜索是快车道 —— 用户知道自己要什么的时候不该被逼着一层层点。
 * 面板不输入关键字就停在节点列表，一输入就在这份索引上过滤。
 */
export function flattenShape(shape: OutputShape): FlatEntry[] {
  const out: FlatEntry[] = []
  const walk = (r: RegionDesc) => {
    for (const f of r.fields) {
      if (f.sensitive) continue
      out.push({ path: f.path, label: f.label, fullLabel: f.fullLabel, valueType: f.valueType, sample: f.sample, known: f.known })
    }
    if (r.table) {
      for (const c of r.table.columns) {
        if (c.sensitive) continue
        // 第一行那一格 —— 「取一个值」最常见的形状，和 pushFirstRowVars 一致
        out.push({
          path: `${r.table.container}[0].${c.name}`,
          label: `${c.name} · 第一行`,
          fullLabel: `${r.label} · ${c.name} · 第一行`,
          valueType: c.type,
          sample: r.table.sampleRows[0]?.[c.name],
          known: r.table.sampleRows.length > 0,
        })
      }
    }
    r.regions.forEach(walk)
  }
  walk(shape.root)
  return out
}
